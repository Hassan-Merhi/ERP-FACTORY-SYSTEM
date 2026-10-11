import { Loader2, Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatWidgetInputProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  poDraftUploading: boolean;
  isPending: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  message: string;
  setMessage: (msg: string) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleSend: () => void;
  isError: boolean;
}

export function ChatWidgetInput({
  fileInputRef,
  handleFileSelect,
  poDraftUploading,
  isPending,
  inputRef,
  message,
  setMessage,
  handleKeyDown,
  handleSend,
  isError,
}: ChatWidgetInputProps) {
  return (
    <div className="p-4 border-t bg-background">
      <div className="flex items-center gap-1 bg-muted/50 dark:bg-zinc-800/50 rounded-2xl border border-border/60 px-1 pr-1.5 focus-within:border-blue-300 dark:focus-within:border-blue-700 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-900/40 transition-all">
        <input
          ref={fileInputRef as React.RefObject<HTMLInputElement>}
          type="file"
          accept=".pdf,.xlsx,.xls,.csv"
          className="hidden"
          onChange={handleFileSelect}
          data-testid="input-po-file"
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 rounded-xl shrink-0 text-muted-foreground"
          onClick={() => fileInputRef.current?.click()}
          disabled={poDraftUploading || isPending}
          title="Import PO from file"
          data-testid="button-upload-po-file"
        >
          {poDraftUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </Button>
        <Input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          placeholder="Ask anything..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isPending}
          className="flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0 px-1 h-10 text-sm placeholder:text-muted-foreground/60"
          data-testid="input-chat-message"
        />
        <Button
          size="icon"
          className="h-9 w-9 rounded-xl shrink-0 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-black dark:hover:bg-white"
          onClick={() => handleSend()}
          disabled={!message.trim() || isPending}
          data-testid="button-send-message"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 ml-0.5" />}
        </Button>
      </div>
      {isError && (
        <p className="text-xs text-destructive mt-2" data-testid="text-chat-error">
          Failed to send message. Please try again.
        </p>
      )}
      <p className="text-center mt-2 text-[11px] text-muted-foreground/50 font-medium tracking-wide uppercase">
        AI responses may be inaccurate
      </p>
    </div>
  );
}
