import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ChevronDown, ChevronUp, Download, Eraser, Pause, Search } from 'lucide-react';
import { jobsApi } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/copy-button';
import { cn } from '@/lib/utils';

/** 保留的最大日志行数：避免长任务把 DOM 撑爆 */
const MAX_LINES = 5000;

/**
 * 任务日志查看器。
 *
 * 既有实现的问题：
 *  - queryKey 里带 offset，每轮轮询都新建一个缓存条目，展开多个任务后残留大量缓存
 *  - 把每个 chunk 原样塞进 <pre>，长日志会渲染几千个节点
 *  - 子进程输出里的 ANSI 转义序列直接显示成乱码（`\x1b[32m`）
 *  - 每 2s 无条件把滚动条拉到底，用户想往回看就被打断
 */
export function LogViewer({ jobId, status }: { jobId: string; status?: string }) {
  const [text, setText] = useState('');
  const [eof, setEof] = useState(false);
  const offsetRef = useRef(0);
  /** refetchInterval 回调里读不到 state，用 ref 同步 eof */
  const eofRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);

  const finished = status ? ['completed', 'failed', 'canceled'].includes(status) : false;
  // offset 放在 ref 里、每轮用「同一 queryKey + 取消缓存」取增量：
  // 这样只有一个缓存条目，也不会因为 key 变化产生新条目
  const { data, isFetching, refetch } = useQuery({
    // state 进 key 只为了触发轮询重算；queryFn 不读它，所以不会造成额外缓存条目
    // （真正的 offset 在 ref 里，永远只有 ['jobs', id, 'logs'] 这一个条目）
    queryKey: ['jobs', jobId, 'logs'],
    queryFn: async () => {
      const result = await jobsApi.logs(jobId, offsetRef.current);
      offsetRef.current = result.next_offset;
      return result;
    },
    // 终态任务不再轮询（日志不会再增长）；eof 后同样停止
    refetchInterval: () => (finished || eofRef.current ? false : 2000),
    staleTime: 0,
    gcTime: 30_000,
  });

  useEffect(() => {
    offsetRef.current = 0;
    eofRef.current = false;
    setText('');
    setEof(false);
  }, [jobId]);

  useEffect(() => {
    if (!data?.chunk) return;
    setText((prev) => trimToLines(prev + data.chunk, MAX_LINES));
    setEof(Boolean(data.eof));
    eofRef.current = Boolean(data.eof);
  }, [data]);

  const lines = useMemo(() => text.replace(/\r\n?/g, '\n').split('\n'), [text]);

  // 关键字命中位置（行号）
  const hits = useMemo(() => {
    if (!query.trim()) return [];
    const needle = query.trim().toLowerCase();
    const found: number[] = [];
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) found.push(index);
    });
    return found;
  }, [lines, query]);

  useEffect(() => setHitIndex(0), [query]);

  // 只在新内容到达且用户仍贴在底部时才自动滚底
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !autoScroll) return;
    el.scrollTop = el.scrollHeight;
  }, [text, autoScroll]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  }, []);

  const gotoHit = (direction: 1 | -1) => {
    if (hits.length === 0) return;
    const next = (hitIndex + direction + hits.length) % hits.length;
    setHitIndex(next);
    setAutoScroll(false);
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-line="${hits[next]}"]`);
    el?.scrollIntoView({ block: 'center' });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="在日志中查找…"
            className="h-7 w-52 pl-8 text-xs"
            onKeyDown={(event) => {
              if (event.key === 'Enter') gotoHit(event.shiftKey ? -1 : 1);
            }}
          />
        </div>
        {query.trim() && (
          <>
            <span className="tabular-nums text-xs text-muted-foreground">
              {hits.length === 0 ? '无匹配' : `${hitIndex + 1} / ${hits.length}`}
            </span>
            <Button variant="outline" size="icon-sm" onClick={() => gotoHit(-1)} disabled={hits.length === 0} aria-label="上一个匹配">
              <ChevronUp />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => gotoHit(1)} disabled={hits.length === 0} aria-label="下一个匹配">
              <ChevronDown />
            </Button>
          </>
        )}
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {lines.length} 行{!eof && <span className="ml-1 animate-pulse">▍</span>}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAutoScroll(true);
            void refetch();
          }}
          disabled={isFetching}
        >
          {autoScroll ? <Pause /> : <ArrowDownToLine />}
          {autoScroll ? '暂停滚动' : '回到底部'}
        </Button>
        <CopyButton value={text} label="复制日志" size="sm" variant="outline" />
        <Button variant="outline" size="sm" onClick={() => downloadLog(jobId, text)}>
          <Download />
          下载
        </Button>
        <Button variant="outline" size="sm" onClick={() => setText('')}>
          <Eraser />
          清屏
        </Button>
      </div>

      <div
        ref={containerRef}
        onScroll={onScroll}
        className="max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-black/60 p-3 font-mono text-xs leading-relaxed text-zinc-200 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]"
      >
        {lines.length === 0 || (lines.length === 1 && lines[0] === '') ? (
          <div className="text-zinc-500">暂无日志…</div>
        ) : (
          lines.map((line, index) => (
            <LogLine
              key={index}
              line={line}
              lineNumber={index}
              query={query.trim()}
              active={hits[hitIndex] === index}
            />
          ))
        )}
      </div>
    </div>
  );
}

function downloadLog(jobId: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${jobId}.log`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 保留最多 maxLines 行（按行裁剪，避免从半行处切开）。 */
export function trimToLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join('\n');
}

const ANSI_COLORS: Record<number, string> = {
  31: 'log-ansi-red',
  32: 'log-ansi-green',
  33: 'log-ansi-yellow',
  34: 'log-ansi-blue',
  35: 'log-ansi-magenta',
  36: 'log-ansi-cyan',
  91: 'log-ansi-red',
  92: 'log-ansi-green',
  93: 'log-ansi-yellow',
  94: 'log-ansi-blue',
  95: 'log-ansi-magenta',
  96: 'log-ansi-cyan',
};

interface Segment {
  text: string;
  className?: string;
}

/**
 * 解析一行里的 ANSI SGR 转义序列为着色片段。
 * 只处理颜色/加粗/暗淡，其余序列（光标移动等）直接丢弃，避免显示乱码。
 */
export function parseAnsi(line: string): Segment[] {
  const segments: Segment[] = [];
  const classes: string[] = [];
  // eslint-disable-next-line no-control-regex
  const pattern = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const push = (text: string) => {
    if (!text) return;
    segments.push({ text, className: classes.length ? classes.join(' ') : undefined });
  };

  while ((match = pattern.exec(line)) !== null) {
    push(line.slice(last, match.index));
    last = pattern.lastIndex;
    for (const code of match[1].split(';').filter(Boolean).map(Number)) {
      if (code === 0) classes.length = 0;
      else if (code === 1) classes.push('log-ansi-bold');
      else if (code === 2) classes.push('log-ansi-dim');
      else if (ANSI_COLORS[code]) classes.push(ANSI_COLORS[code]);
    }
  }
  push(line.slice(last));
  // 没有转义序列时保持纯文本（不自造片段，减少节点）
  return segments;
}

function LogLine({
  line,
  lineNumber,
  query,
  active,
}: {
  line: string;
  lineNumber: number;
  query: string;
  active: boolean;
}) {
  const segments = useMemo(() => parseAnsi(line), [line]);
  const isError = /\b(error|failed|exception|traceback|❌)\b/i.test(line);

  return (
    <div
      data-line={lineNumber}
      className={cn(
        'whitespace-pre-wrap break-all',
        isError && 'text-red-300',
        active && 'rounded bg-white/10',
      )}
    >
      {segments.length === 0 ? (
        '\u00a0'
      ) : (
        segments.map((segment, index) => (
          <span key={index} className={segment.className}>
            {query ? <Highlight text={segment.text} query={query} /> : segment.text}
          </span>
        ))
      )}
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(needle);
  if (found === -1) return <>{text}</>;
  if (found < 0) return <>{text}</>;
  while (found !== -1) {
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(
      <mark key={`${found}-${parts.length}`} className="log-hit">
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    cursor = found + needle.length;
    found = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
