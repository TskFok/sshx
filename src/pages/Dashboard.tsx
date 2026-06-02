import { useNavigate } from "react-router-dom";
import { Server, Terminal, FolderOpen, Plus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAppStore } from "@/store";

export function Dashboard() {
  const navigate = useNavigate();
  const connections = useAppStore((s) => s.connections);
  const sessions = useAppStore((s) => s.sessions);
  const groups = useAppStore((s) => s.groups);

  const stats = [
    {
      title: "连接总数",
      value: connections.length,
      icon: Server,
      color: "text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400",
    },
    {
      title: "活跃会话",
      value: sessions.length,
      icon: Terminal,
      color:
        "text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400",
    },
    {
      title: "连接分组",
      value: groups.length,
      icon: FolderOpen,
      color:
        "text-purple-600 bg-purple-100 dark:bg-purple-900/30 dark:text-purple-400",
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="border-none bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">欢迎使用 SSHX</CardTitle>
          <CardDescription className="text-blue-100">
            跨平台 SSH 连接管理器 —— 安全、高效地管理你的远程主机
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="bg-white/20 text-white hover:bg-white/30 border-0"
              onClick={() => navigate("/connections")}
            >
              <Plus className="h-4 w-4 mr-2" />
              新建连接
            </Button>
            <Button
              variant="secondary"
              className="bg-white/10 text-white hover:bg-white/20 border-0"
              onClick={() => navigate("/terminal")}
            >
              <Terminal className="h-4 w-4 mr-2" />
              打开终端
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardContent className="flex items-center gap-4 p-6">
              <div className={`rounded-lg p-3 ${stat.color}`}>
                <stat.icon className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{stat.title}</p>
                <p className="text-3xl font-bold">{stat.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg">最近连接</CardTitle>
              <CardDescription>最近使用的 SSH 连接</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/connections")}
            >
              查看全部
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {connections.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Server className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">
                  还没有保存的连接
                </p>
                <Button
                  variant="link"
                  className="mt-2"
                  onClick={() => navigate("/connections")}
                >
                  添加第一个连接
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {connections.slice(0, 5).map((conn) => (
                  <div
                    key={conn.id}
                    className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                        <Server className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{conn.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {conn.username}@{conn.host}:{conn.port}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        navigate("/terminal", {
                          state: { connectionId: conn.id },
                        })
                      }
                    >
                      连接
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">快速指南</CardTitle>
            <CardDescription>开始使用 SSHX</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                {
                  step: "1",
                  title: "添加连接",
                  desc: "在连接管理页面添加你的 SSH 服务器信息",
                },
                {
                  step: "2",
                  title: "选择认证方式",
                  desc: "支持密码认证和 SSH 密钥认证两种方式",
                },
                {
                  step: "3",
                  title: "打开终端",
                  desc: "点击连接即可在内置终端中操作远程主机",
                },
              ].map((item) => (
                <div key={item.step} className="flex gap-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
                    {item.step}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
