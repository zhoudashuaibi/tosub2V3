import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogOut, Save } from 'lucide-react';
import { toast } from 'sonner';
import { authApi, settingsApi } from '@/api';
import { errorMessage } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/input';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get(),
  });
  const { data: sessions } = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => authApi.sessions(),
  });

  // 安全
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const changePassword = useMutation({
    mutationFn: () => authApi.changePassword({ current_password: currentPassword, new_password: newPassword }),
    onSuccess: () => {
      toast.success('密码已修改，其他设备已全部登出');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const logoutAll = useMutation({
    mutationFn: () => authApi.logoutAll(),
    onSuccess: () => {
      toast.success('已登出所有设备');
      window.location.href = '/login';
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // 邮箱取件 / 引擎
  const [twofaTemplate, setTwofaTemplate] = useState('');
  const [maxJobs, setMaxJobs] = useState('');
  const [timeoutMin, setTimeoutMin] = useState('');
  const [failThreshold, setFailThreshold] = useState('');
  const [strictProxy, setStrictProxy] = useState(true);
  useEffect(() => {
    if (settings) {
      setTwofaTemplate(settings.twofa_fetch_template);
      setMaxJobs(String(settings.max_concurrent_jobs));
      setTimeoutMin(String(settings.job_timeout_minutes));
      setFailThreshold(String(settings.proxy_fail_threshold));
      setStrictProxy(settings.strict_proxy !== false);
    }
  }, [settings]);

  const saveSettings = useMutation({
    mutationFn: () =>
      settingsApi.update({
        twofa_fetch_template: twofaTemplate,
        max_concurrent_jobs: Number(maxJobs),
        job_timeout_minutes: Number(timeoutMin),
        proxy_fail_threshold: Number(failThreshold),
        strict_proxy: strictProxy,
      }),
    onSuccess: () => {
      toast.success('设置已保存');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // 接码平台
  const [smsTab, setSmsTab] = useState('custom');
  const [lubanKey, setLubanKey] = useState('');
  const [lubanService, setLubanService] = useState('');
  const [smsbowerKey, setSmsbowerKey] = useState('');
  const [smsbowerCountry, setSmsbowerCountry] = useState('');
  const [customEntries, setCustomEntries] = useState('');
  const saveSms = useMutation({
    mutationFn: () => {
      if (smsTab === 'custom') return settingsApi.saveSmsProvider({ id: 'custom', entries: customEntries, active: 'custom' });
      if (smsTab === 'luban')
        return settingsApi.saveSmsProvider({
          id: 'luban',
          api_key: lubanKey || undefined,
          service_id: lubanService,
          active: 'luban',
        });
      return settingsApi.saveSmsProvider({
        id: 'smsbower',
        api_key: smsbowerKey || undefined,
        country: smsbowerCountry,
        active: 'smsbower',
      });
    },
    onSuccess: () => {
      toast.success('接码平台配置已保存');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>安全</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label>当前密码</Label>
              <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>新密码（≥8 位）</Label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>确认新密码</Label>
              <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
          </div>
          <Button
            onClick={() => {
              if (newPassword.length < 8) return toast.error('新密码至少 8 位');
              if (newPassword !== confirmPassword) return toast.error('两次输入的新密码不一致');
              changePassword.mutate();
            }}
            disabled={changePassword.isPending || !currentPassword || !newPassword}
          >
            {changePassword.isPending && <Loader2 className="animate-spin" />}
            修改密码
          </Button>
          <Button variant="outline" onClick={() => logoutAll.mutate()} disabled={logoutAll.isPending}>
            <LogOut className="h-4 w-4" />
            登出所有设备
          </Button>

          <div className="rounded-md border">
            <div className="border-b px-4 py-2 text-sm font-medium">活跃会话</div>
            {(sessions?.items ?? []).map((session, i) => (
              <div key={i} className="flex items-center justify-between gap-4 border-b px-4 py-2 text-sm last:border-0">
                <div className="min-w-0">
                  <span className="font-mono text-xs">{session.ip ?? '未知 IP'}</span>
                  <div className="truncate text-xs text-muted-foreground" title={session.user_agent ?? ''}>
                    {session.user_agent ?? '未知设备'}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  最近活跃 {formatRelativeTime(session.last_seen_at)}
                  {session.current && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">当前</span>}
                  <span title={formatDateTime(session.expires_at)}>过期 {formatRelativeTime(session.expires_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>邮箱取件与引擎参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Outlook 取件方式</Label>
            <div className="text-sm">微软官方直连</div>
          </div>
          <div className="space-y-1.5">
            <Label>2FA 取码地址模板</Label>
            <Input
              value={twofaTemplate}
              onChange={(e) => setTwofaTemplate(e.target.value)}
              placeholder="https://2fa.show/2fa/{code}"
            />
            <p className="text-xs text-muted-foreground">
              登录遇到两步验证时，按此地址获取 6 位验证码；{`{code}`} 会替换为账号的 2FA 取件码（也支持以 xxx 结尾），留空恢复默认
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>最大并发任务数</Label>
              <Input value={maxJobs} onChange={(e) => setMaxJobs(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>任务超时（分钟）</Label>
              <Input value={timeoutMin} onChange={(e) => setTimeoutMin(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>代理失败阈值</Label>
              <Input value={failThreshold} onChange={(e) => setFailThreshold(e.target.value)} />
            </div>
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3">
            <Switch checked={strictProxy} onCheckedChange={setStrictProxy} className="mt-0.5" />
            <span className="space-y-1 text-sm">
              <span className="block font-medium">禁止无代理直连</span>
              <span className="block text-xs text-muted-foreground">
                开启后，代理池无可用代理时登录/查余额任务直接失败，绝不以本机 IP
                直连上游（服务器 IP 已被上游拉黑时必须开启，否则一登录就封号）
              </span>
            </span>
          </label>
          <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
            {saveSettings.isPending && <Loader2 className="animate-spin" />}
            <Save className="h-4 w-4" />
            保存设置
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>接码平台</CardTitle>
          <CardDescription>
            当前激活：{settings?.sms.active ?? 'custom'}；api_key 加密存储，保存后不回显
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={smsTab} onValueChange={setSmsTab}>
            <TabsList>
              <TabsTrigger value="custom">自定义号池</TabsTrigger>
              <TabsTrigger value="luban">LubanSMS</TabsTrigger>
              <TabsTrigger value="smsbower">SMSBower</TabsTrigger>
            </TabsList>
            <TabsContent value="custom" className="space-y-3 pt-3">
              <div className="space-y-1.5">
                <Label>手机号与接码 API（每行：+86xxx----https://…）</Label>
                <Textarea
                  value={customEntries}
                  onChange={(e) => setCustomEntries(e.target.value)}
                  placeholder={'+861871291167----https://example.com/messages/1871291167'}
                  className="min-h-[120px] font-mono text-xs"
                />
              </div>
            </TabsContent>
            <TabsContent value="luban" className="space-y-3 pt-3">
              <div className="space-y-1.5">
                <Label>API Key{settings?.sms.providers.luban.configured ? '（已配置，留空不修改）' : ''}</Label>
                <Input type="password" value={lubanKey} onChange={(e) => setLubanKey(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>供应商编号</Label>
                <Input
                  value={lubanService || settings?.sms.providers.luban.service_id || ''}
                  onChange={(e) => setLubanService(e.target.value)}
                  placeholder="例如 121949"
                />
              </div>
            </TabsContent>
            <TabsContent value="smsbower" className="space-y-3 pt-3">
              <div className="space-y-1.5">
                <Label>API Key{settings?.sms.providers.smsbower.configured ? '（已配置，留空不修改）' : ''}</Label>
                <Input type="password" value={smsbowerKey} onChange={(e) => setSmsbowerKey(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>国家 ID</Label>
                <Input
                  value={smsbowerCountry || settings?.sms.providers.smsbower.country || ''}
                  onChange={(e) => setSmsbowerCountry(e.target.value)}
                  placeholder="例如 1001"
                />
              </div>
            </TabsContent>
          </Tabs>
          <Button className="mt-4" onClick={() => saveSms.mutate()} disabled={saveSms.isPending}>
            {saveSms.isPending && <Loader2 className="animate-spin" />}
            保存并激活该平台
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
