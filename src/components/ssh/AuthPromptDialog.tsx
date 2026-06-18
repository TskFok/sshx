import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AuthPromptData {
  sessionId: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

interface AuthPromptDialogProps {
  prompt: AuthPromptData | null;
  responses: string[];
  onResponsesChange: (responses: string[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function AuthPromptDialog({
  prompt,
  responses,
  onResponsesChange,
  onSubmit,
  onCancel,
}: AuthPromptDialogProps) {
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{prompt?.name || "SSH 认证"}</DialogTitle>
          {prompt?.instructions && (
            <DialogDescription>{prompt.instructions}</DialogDescription>
          )}
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {prompt?.prompts.map((item, index) => (
            <div key={`${item.prompt}-${index}`} className="space-y-2">
              <Label>{item.prompt}</Label>
              <Input
                type={item.echo ? "text" : "password"}
                value={responses[index] ?? ""}
                onChange={(event) => {
                  const next = [...responses];
                  next[index] = event.target.value;
                  onResponsesChange(next);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onSubmit();
                  }
                }}
                autoFocus={index === 0}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onSubmit}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
