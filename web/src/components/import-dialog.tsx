import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Loader2, FileUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { joinEmails } from '@/lib/utils';
import type { ImportResult, ProxyImportResult } from '@/api/types';

function isAccountResult(result: ImportResult | ProxyImportResult): result is ImportResult {
  return 'duplicates_in_main' in result;
}

export function ImportDialog({
  open,
  onOpenChange,
  title,
  placeholder,
  description,
  submitLabel = '导入',
  onSubmit,
  result,
  onClosed,
  busy,
  initialText,
  extraAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  placeholder: string;
  /** 覆盖默认的「每行一条」说明（如 JSON 文件导入） */
  description?: string;
  submitLabel?: string;
  onSubmit: (text: string) => void;
  result: ImportResult | ProxyImportResult | null;
  onClosed?: () => void;
  busy?: boolean;
  /** 打开时预填的文本（「查看详情」重开时还原上次导入内容，便于带参重提交） */
  initialText?: string;
  /** 附加提交动作（如远端重复时「收编进主号池」），与主提交共用对话框文本 */
  extraAction?: { label: string; onSubmit: (text: string) => void };
}) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // 关闭会清空文本：重新打开时用 initialText 还原（不覆盖用户已输入的内容）
  useEffect(() => {
    if (open) setText((current) => current || initialText || '');
  }, [open, initialText]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setText('');
      setFileName('');
      onClosed?.();
    }
    onOpenChange(nextOpen);
  };

  const handleFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch {
      setFileName('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description || '每行一条，支持以 # 开头的注释行'}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {fileName ? `已读取文件：${fileName}` : '可粘贴文本，或选择文件导入'}
          </div>
          <Button type="button" variant="outline" size="sm" className="h-6 shrink-0" onClick={() => fileRef.current?.click()}>
            <FileUp className="h-3.5 w-3.5" />
            选择文件…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt"
            className="hidden"
            onChange={(e) => {
              handleFileChosen(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (fileName) setFileName('');
          }}
          placeholder={placeholder}
          className="min-h-[130px] font-mono text-xs"
          spellCheck={false}
        />
        {result && <ImportResultView result={result} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            关闭
          </Button>
          {extraAction && (
            <Button variant="outline" onClick={() => extraAction.onSubmit(text)} disabled={busy || !text.trim()}>
              {extraAction.label}
            </Button>
          )}
          <Button onClick={() => onSubmit(text)} disabled={busy || !text.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportResultView({ result }: { result: ImportResult | ProxyImportResult }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex items-center gap-2 text-[var(--success)]">
        <CheckCircle2 className="h-4 w-4" />
        成功导入 {result.created} 条
      </div>
      {isAccountResult(result) && result.duplicates_in_main.length > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{joinEmails(result.duplicates_in_main)} 已在主号池中</span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_in_reserve.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{joinEmails(result.duplicates_in_reserve)} 已在备用号池（凭据已更新）</span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_in_batch.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>批内重复已跳过：{joinEmails(result.duplicates_in_batch)}</span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_in_discard.length > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {result.duplicates_in_discard.map((d) => `${d.email}（${d.reason}）`).join('、')} 曾在废弃号池，重新导入需勾选「仍然导入」
          </span>
        </div>
      )}
      {isAccountResult(result) && result.duplicates_remote.length > 0 && (
        <div className="flex items-start gap-2 text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{joinEmails(result.duplicates_remote)} 已在远端 sub2api：可收编进主号池（直接关联远端，不重新登录），或再次导入强制入备用池</span>
        </div>
      )}
      {isAccountResult(result) && (result.adopted_remote?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 text-[var(--info)]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>已收编进主号池（关联远端账号，不重新登录）：{joinEmails(result.adopted_remote ?? [])}</span>
        </div>
      )}
      {!isAccountResult(result) && result.duplicates.length > 0 && (
        <div className="flex items-start gap-2 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>重复已跳过：{result.duplicates.length} 条</span>
        </div>
      )}
      {result.invalid_lines.length > 0 && (
        <div className="flex items-start gap-2 text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {result.invalid_lines.slice(0, 8).map((line) => (
              <div key={line.line}>
                第 {line.line} 行：{line.reason}
              </div>
            ))}
            {result.invalid_lines.length > 8 && <div>…共 {result.invalid_lines.length} 行非法</div>}
          </div>
        </div>
      )}
    </div>
  );
}
