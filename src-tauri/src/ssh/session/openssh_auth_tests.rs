use super::*;

const MFA_LOG: &str = concat!(
    "debug3: receive packet: type 60\r\n",
    "debug2: input_userauth_info_req: entering\r\n",
    "Please enter 6 digits.\r\n",
    "debug2: input_userauth_info_req: num_prompts 1\r\n",
);
const MFA_PROMPT: &str = "(demo@jump.example.com) MFA code: ";
const WAIT: Duration = Duration::from_secs(2);

struct AuthInputWriter(mpsc::UnboundedSender<Vec<u8>>);

impl Write for AuthInputWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.send(bytes.to_vec()).unwrap();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct AuthSession {
    log_path: std::path::PathBuf,
    pty: mpsc::Sender<Vec<u8>>,
    responses: mpsc::UnboundedSender<Vec<String>>,
    prompts: mpsc::UnboundedReceiver<AuthPromptPayload>,
    input: mpsc::UnboundedReceiver<Vec<u8>>,
    task: tokio::task::JoinHandle<Result<bool, String>>,
}

impl AuthSession {
    fn start(log: &str) -> Self {
        let log_path =
            std::env::temp_dir().join(format!("sshx-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&log_path, log).unwrap();
        let (pty, mut pty_rx) = mpsc::channel(16);
        let (responses, mut auth_rx) = mpsc::unbounded_channel();
        let (prompt_tx, prompts) = mpsc::unbounded_channel();
        let (input_tx, input) = mpsc::unbounded_channel();
        let path = log_path.clone();
        let task = tokio::spawn(async move {
            let writer: Arc<Mutex<Box<dyn Write + Send>>> =
                Arc::new(Mutex::new(Box::new(AuthInputWriter(input_tx))));
            run_auth_until_ready(
                None,
                &mut auth_rx,
                "mfa-regression",
                &AuthMethod::KeyFile("unused-test-key".into()),
                path.to_str().unwrap(),
                &mut pty_rx,
                &writer,
                None,
                |payload| prompt_tx.send(payload).map_err(|e| e.to_string()),
            )
            .await
        });
        Self {
            log_path,
            pty,
            responses,
            prompts,
            input,
            task,
        }
    }

    fn append_log(&self, text: &str) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&self.log_path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    async fn answer_prompt(&mut self, code: &str) {
        let prompt = tokio::time::timeout(WAIT, self.prompts.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(prompt.prompts.len(), 1);
        assert_eq!(prompt.prompts[0].prompt, MFA_PROMPT.trim());
        self.responses.send(vec![code.into()]).unwrap();
        let input = tokio::time::timeout(WAIT, self.input.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(input, format!("{code}\n").as_bytes());
    }

    async fn assert_no_interaction(&mut self) {
        tokio::select! {
            prompt = self.prompts.recv() => panic!("没有新终端提示却再次弹窗: {prompt:?}"),
            input = self.input.recv() => panic!("没有用户应答却自动写入: {input:?}"),
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }

    async fn finish(&mut self) {
        self.append_log(concat!(
            "debug3: send packet: type 61\r\n",
            "debug3: receive packet: type 52\r\n",
            "Authenticated to jump.example.com using \"keyboard-interactive\".\r\n",
        ));
        assert!(tokio::time::timeout(WAIT, &mut self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap());
        assert!(self.prompts.try_recv().is_err());
        assert!(self.input.try_recv().is_err());
    }
}

impl Drop for AuthSession {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.log_path);
    }
}

#[tokio::test]
async fn mfa_log_instruction_before_pty_does_not_open_a_dialog() {
    let mut session = AuthSession::start(MFA_LOG);
    session.assert_no_interaction().await;
    session
        .pty
        .send(MFA_PROMPT.as_bytes().to_vec())
        .await
        .unwrap();
    session.answer_prompt("123456").await;
    session.assert_no_interaction().await;
    session.finish().await;
}

#[tokio::test]
async fn mfa_delayed_log_instruction_does_not_repeat_answered_prompt() {
    let mut session = AuthSession::start("");
    session
        .pty
        .send(MFA_PROMPT.as_bytes().to_vec())
        .await
        .unwrap();
    session.answer_prompt("123456").await;
    session.append_log(MFA_LOG);
    session.assert_no_interaction().await;
    session.finish().await;
}

#[tokio::test]
async fn mfa_same_prompt_in_a_new_round_requires_a_new_answer() {
    let mut session = AuthSession::start("");
    session
        .pty
        .send(MFA_PROMPT.as_bytes().to_vec())
        .await
        .unwrap();
    session.answer_prompt("123456").await;
    session
        .pty
        .send(format!("\r\n{MFA_PROMPT}").into_bytes())
        .await
        .unwrap();
    session.answer_prompt("654321").await;
    session.finish().await;
}

#[tokio::test]
async fn mfa_answer_consumes_all_previous_pty_prompt_text() {
    let mut session = AuthSession::start("");
    session
        .pty
        .send(format!("Please enter 6 digits.\r\n{MFA_PROMPT}").into_bytes())
        .await
        .unwrap();
    session.answer_prompt("123456").await;
    session.assert_no_interaction().await;
    session.finish().await;
}
