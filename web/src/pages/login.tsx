import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { authApi } from '@/api';
import { errorMessage } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** 粗略的密码强度分级：只用于提示，真正的长度校验在后端 */
function passwordStrength(password: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (password.length < 8) return { score: 0, label: '至少 8 位' };
  let score = 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return { score: score as 1 | 2 | 3, label: ['至少 8 位', '较弱', '中等', '较强'][score] };
}

export function LoginPage() {
  const navigate = useNavigate();
  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => authApi.session(),
    retry: false,
  });
  const isSetup = session ? !session.password_initialized : false;

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (session?.authenticated) navigate({ to: '/' });
  }, [session, navigate]);

  const login = useMutation({
    mutationFn: () => (isSetup ? authApi.login({ new_password: password }) : authApi.login({ password })),
    onSuccess: () => {
      toast.success(isSetup ? '密码已设置' : '登录成功');
      navigate({ to: '/' });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = () => {
    setError('');
    if (isSetup) {
      if (password.length < 8) return setError('密码至少 8 位');
      if (password !== confirm) return setError('两次输入的密码不一致');
    }
    if (!password) return setError('请输入密码');
    login.mutate();
  };

  const strength = passwordStrength(password);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-6">
      <Card className="w-full max-w-sm overflow-hidden">
        <CardHeader className="gap-2 border-b px-6 py-7 text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            S2
          </div>
          <div className="text-xs text-muted-foreground">账户访问</div>
          <CardTitle className="text-lg font-semibold">toSub2 控制台</CardTitle>
          <CardDescription>{isSetup ? '首次访问，请设置访问密码' : '请输入访问密码'}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-6 pt-6">
          {isSetup && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--warning)]/20 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              系统部署在公网，请设置强密码（至少 8 位）。密码用于保护账号凭据与令牌。
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{isSetup ? '设置访问密码' : '访问密码'}</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && submit()}
                placeholder="••••••••"
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                autoFocus
                aria-invalid={Boolean(error)}
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {isSetup && password.length > 0 && (
              <div className="flex items-center gap-2">
                <div className="flex h-1 flex-1 gap-1">
                  {[1, 2, 3].map((level) => (
                    <span
                      key={level}
                      className={cn(
                        'h-full flex-1 rounded-full',
                        strength.score >= level
                          ? strength.score >= 3
                            ? 'bg-[var(--success)]'
                            : strength.score === 2
                              ? 'bg-[var(--warning)]'
                              : 'bg-destructive'
                          : 'bg-muted',
                      )}
                    />
                  ))}
                </div>
                <span className="w-14 text-right text-[11px] text-muted-foreground">{strength.label}</span>
              </div>
            )}
          </div>

          {isSetup && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && submit()}
                placeholder="再次输入密码"
                autoComplete="new-password"
                aria-invalid={Boolean(error) && confirm.length > 0 && confirm !== password}
              />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button className="w-full" onClick={submit} disabled={login.isPending}>
            <Lock />
            {login.isPending ? '登录中…' : isSetup ? '设置并登录' : '登录'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
