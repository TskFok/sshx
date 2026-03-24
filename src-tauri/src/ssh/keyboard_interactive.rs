use russh::client::Prompt;

/// 服务端先发 0 个 prompt 的“空轮次”时直接回空响应（常见于部分 MFA 握手）。
pub(crate) fn try_auto_ki_empty_prompts_response(prompts: &[Prompt]) -> Option<Vec<String>> {
    if prompts.is_empty() {
        Some(vec![])
    } else {
        None
    }
}

/// 若为首轮 keyboard-interactive、且保存了密码、且服务端只发一个不回显提示（常见为密码框），则自动应答，避免多余弹窗。
pub(crate) fn try_auto_ki_password_response(
    first_round: bool,
    password: Option<&str>,
    prompts: &[Prompt],
) -> Option<Vec<String>> {
    if !first_round {
        return None;
    }
    let pwd = password?;
    if prompts.len() == 1 && !prompts[0].echo {
        Some(vec![pwd.to_string()])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(echo: bool) -> Prompt {
        Prompt {
            prompt: "Password:".to_string(),
            echo,
        }
    }

    #[test]
    fn auto_response_first_round_password_one_prompt_no_echo() {
        let prompts = [prompt(false)];
        let r = try_auto_ki_password_response(true, Some("secret"), &prompts);
        assert_eq!(r, Some(vec!["secret".to_string()]));
    }

    #[test]
    fn no_auto_when_not_first_round() {
        let prompts = [prompt(false)];
        assert!(try_auto_ki_password_response(false, Some("secret"), &prompts).is_none());
    }

    #[test]
    fn no_auto_without_password() {
        let prompts = [prompt(false)];
        assert!(try_auto_ki_password_response(true, None, &prompts).is_none());
    }

    #[test]
    fn no_auto_when_echo_true_otp_style() {
        let prompts = [Prompt {
            prompt: "OTP:".to_string(),
            echo: true,
        }];
        assert!(try_auto_ki_password_response(true, Some("secret"), &prompts).is_none());
    }

    #[test]
    fn no_auto_multiple_prompts() {
        let prompts = [prompt(false), prompt(false)];
        assert!(try_auto_ki_password_response(true, Some("secret"), &prompts).is_none());
    }

    #[test]
    fn empty_prompts_yields_empty_responses() {
        let prompts: [Prompt; 0] = [];
        assert_eq!(try_auto_ki_empty_prompts_response(&prompts), Some(vec![]));
    }

    #[test]
    fn nonempty_prompts_not_empty_auto() {
        let prompts = [prompt(false)];
        assert!(try_auto_ki_empty_prompts_response(&prompts).is_none());
    }
}
