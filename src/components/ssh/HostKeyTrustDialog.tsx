import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createHostKeyTrustController,
  type HostKeyPrompt,
  type HostKeyTrustState,
} from "@/lib/hostKeyTrust";

interface HostKeyTrustContentProps {
  prompt: HostKeyPrompt;
  verified: boolean;
  busy: boolean;
  error: string | null;
  onVerifiedChange: (verified: boolean) => void;
  onCancel: () => void;
  onAccept: () => void;
  cancelRef?: React.Ref<HTMLButtonElement>;
}

export function HostKeyTrustContent({
  prompt,
  verified,
  busy,
  error,
  onVerifiedChange,
  onCancel,
  onAccept,
  cancelRef,
}: HostKeyTrustContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>首次连接：确认 SSH 主机密钥</DialogTitle>
        <DialogDescription>
          此主机的密钥尚未保存。请通过独立渠道向管理员核验下方 SHA256 指纹；仅凭当前连接显示的信息无法确认主机身份。
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border bg-muted/30 p-4 text-sm">
        <dt className="text-muted-foreground">主机</dt>
        <dd className="min-w-0 break-all font-medium">{prompt.host}</dd>
        <dt className="text-muted-foreground">端口</dt>
        <dd>{prompt.port}</dd>
        <dt className="text-muted-foreground">密钥算法</dt>
        <dd className="min-w-0 break-all font-mono">{prompt.algorithm}</dd>
        <dt className="text-muted-foreground">SHA256 指纹</dt>
        <dd className="min-w-0 select-text break-all font-mono">{prompt.fingerprint}</dd>
      </dl>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={verified}
          disabled={busy}
          onChange={(event) => onVerifiedChange(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-primary"
        />
        <span>我已通过独立渠道核验该主机的 SHA256 指纹与上方一致</span>
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button ref={cancelRef} type="button" variant="outline" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="button"
          disabled={!verified || busy}
          onClick={onAccept}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        >
          信任并连接
        </Button>
      </DialogFooter>
    </>
  );
}

function ActiveHostKeyTrustDialog({
  prompt,
  replying,
  error,
  onRespond,
}: {
  prompt: HostKeyPrompt;
  replying: boolean;
  error: string | null;
  onRespond: (requestId: string, accept: boolean) => void;
}) {
  const [verified, setVerified] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !replying) onRespond(prompt.requestId, false); }}>
      <DialogContent
        className="sm:max-w-[520px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <HostKeyTrustContent
          prompt={prompt}
          verified={verified}
          busy={replying}
          error={error}
          onVerifiedChange={setVerified}
          onCancel={() => onRespond(prompt.requestId, false)}
          onAccept={() => { if (verified && !replying) onRespond(prompt.requestId, true); }}
          cancelRef={cancelRef}
        />
      </DialogContent>
    </Dialog>
  );
}

export function HostKeyTrustDialog() {
  const controllerRef = useRef<ReturnType<typeof createHostKeyTrustController> | null>(null);
  const [state, setState] = useState<HostKeyTrustState>({
    prompts: [], replying: false, error: null,
  });

  useEffect(() => {
    const controller = createHostKeyTrustController({
      listen: async (onChanged) => listen("ssh-host-key-prompts-changed", onChanged),
      pending: () => invoke<HostKeyPrompt[]>("ssh_host_key_pending"),
      respond: (requestId, accept) => invoke("ssh_host_key_respond", { requestId, accept }),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setState);
    void controller.start();
    return () => {
      controllerRef.current = null;
      unsubscribe();
      controller.stop();
    };
  }, []);

  const prompt = state.prompts[0];
  if (!prompt) return null;
  return (
    <ActiveHostKeyTrustDialog
      key={prompt.requestId}
      prompt={prompt}
      replying={state.replying}
      error={state.error}
      onRespond={(requestId, accept) => { void controllerRef.current?.respond(requestId, accept); }}
    />
  );
}
