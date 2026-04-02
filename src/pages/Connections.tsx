import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  Search,
  Server,
  Key,
  Lock,
  MoreVertical,
  Pencil,
  Trash2,
  Terminal,
  FolderPlus,
  Zap,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppStore, type ConnectionInfo, type ConnectionGroup } from "@/store";

interface ConnectionFormData {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
  groupId: string | null;
  keepaliveIntervalSecs: number;
  keepaliveMax: number;
}

const emptyForm: ConnectionFormData = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  authType: "password",
  password: "",
  privateKey: "",
  privateKeyPassphrase: "",
  groupId: null,
  keepaliveIntervalSecs: 30,
  keepaliveMax: 3,
};

export function Connections() {
  const navigate = useNavigate();
  const connections = useAppStore((s) => s.connections);
  const setConnections = useAppStore((s) => s.setConnections);
  const groups = useAppStore((s) => s.groups);
  const setGroups = useAppStore((s) => s.setGroups);

  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionFormData>(emptyForm);
  const [groupForm, setGroupForm] = useState({ name: "", color: "#3b82f6" });
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [conns, grps] = await Promise.all([
        invoke<ConnectionInfo[]>("list_connections"),
        invoke<ConnectionGroup[]>("list_groups"),
      ]);
      setConnections(conns);
      setGroups(grps);
    } catch {
      // Will fail outside Tauri - use empty data
    }
  }, [setConnections, setGroups]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async () => {
    try {
      if (editingId) {
        await invoke("update_connection", {
          request: {
            id: editingId,
            name: form.name,
            host: form.host,
            port: form.port,
            username: form.username,
            authType: form.authType,
            password: form.authType === "password" ? form.password : null,
            privateKey: form.authType === "key" ? form.privateKey : null,
            privateKeyPassphrase:
              form.authType === "key" ? form.privateKeyPassphrase || null : null,
            groupId: form.groupId,
            keepaliveIntervalSecs: form.keepaliveIntervalSecs,
            keepaliveMax: form.keepaliveMax,
          },
        });
      } else {
        await invoke("create_connection", {
          request: {
            name: form.name,
            host: form.host,
            port: form.port,
            username: form.username,
            authType: form.authType,
            password: form.authType === "password" ? form.password : null,
            privateKey: form.authType === "key" ? form.privateKey : null,
            privateKeyPassphrase:
              form.authType === "key" ? form.privateKeyPassphrase || null : null,
            groupId: form.groupId,
            keepaliveIntervalSecs: form.keepaliveIntervalSecs,
            keepaliveMax: form.keepaliveMax,
          },
        });
      }
      setDialogOpen(false);
      setForm(emptyForm);
      setEditingId(null);
      loadData();
    } catch (err) {
      console.error("save connection error:", err);
    }
  };

  const handleEdit = async (conn: ConnectionInfo) => {
    setEditingId(conn.id);
    let fullConn = conn;
    try {
      const detail = await invoke<ConnectionInfo>("get_connection", { id: conn.id });
      if (detail) fullConn = detail;
    } catch {
      // fall back to list data
    }
    setForm({
      name: fullConn.name,
      host: fullConn.host,
      port: fullConn.port,
      username: fullConn.username,
      authType: fullConn.authType as "password" | "key",
      password: "",
      privateKey: fullConn.privateKey ?? "",
      privateKeyPassphrase: "",
      groupId: fullConn.groupId,
      keepaliveIntervalSecs: fullConn.keepaliveIntervalSecs ?? 30,
      keepaliveMax: fullConn.keepaliveMax ?? 3,
    });
    setDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("delete_connection", { id });
      loadData();
    } catch (err) {
      console.error("delete error:", err);
    }
  };

  const handleConnect = (conn: ConnectionInfo) => {
    navigate("/terminal", { state: { connectionId: conn.id } });
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const msg = await invoke<string>("test_connection", {
        request: {
          host: form.host,
          port: form.port,
          username: form.username,
          authType: form.authType,
          password: form.authType === "password" ? form.password : null,
          privateKey: form.authType === "key" ? form.privateKey : null,
          privateKeyPassphrase:
            form.authType === "key" ? form.privateKeyPassphrase || null : null,
          keepaliveIntervalSecs: form.keepaliveIntervalSecs,
          keepaliveMax: form.keepaliveMax,
        },
      });
      setTestResult({ ok: true, message: msg });
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        message: typeof err === "string" ? err : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveGroup = async () => {
    try {
      await invoke("create_group", {
        request: { name: groupForm.name, color: groupForm.color },
      });
      setGroupDialogOpen(false);
      setGroupForm({ name: "", color: "#3b82f6" });
      loadData();
    } catch (err) {
      console.error("save group error:", err);
    }
  };

  const filteredConnections = connections.filter((c) => {
    const matchesSearch =
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.host.toLowerCase().includes(search.toLowerCase());
    const matchesGroup = !selectedGroup || c.groupId === selectedGroup;
    return matchesSearch && matchesGroup;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">连接管理</h2>
          <p className="text-muted-foreground">管理你的 SSH 连接和分组</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setGroupDialogOpen(true)}
          >
            <FolderPlus className="mr-2 h-4 w-4" />
            新建分组
          </Button>
          <Button
            onClick={() => {
              setEditingId(null);
              setForm(emptyForm);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            新建连接
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索连接..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {groups.length > 0 && (
          <Select
            value={selectedGroup ?? "all"}
            onValueChange={(v) => setSelectedGroup(v === "all" ? null : v)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="全部分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: g.color }}
                    />
                    {g.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {filteredConnections.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Server className="h-16 w-16 text-muted-foreground/20 mb-4" />
            <h3 className="text-lg font-medium mb-1">还没有连接</h3>
            <p className="text-sm text-muted-foreground mb-4">
              添加你的第一个 SSH 连接
            </p>
            <Button
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              新建连接
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredConnections.map((conn) => {
            const group = groups.find((g) => g.id === conn.groupId);
            return (
              <Card
                key={conn.id}
                className="transition-shadow hover:shadow-md cursor-pointer"
                onClick={() => handleConnect(conn)}
              >
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Server className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{conn.name}</CardTitle>
                      <CardDescription className="text-xs">
                        {conn.username}@{conn.host}:{conn.port}
                      </CardDescription>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      asChild
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleConnect(conn);
                        }}
                      >
                        <Terminal className="mr-2 h-4 w-4" />
                        连接
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(conn);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        编辑
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(conn.id);
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">
                      {conn.authType === "password" ? (
                        <>
                          <Lock className="mr-1 h-3 w-3" />
                          密码
                        </>
                      ) : (
                        <>
                          <Key className="mr-1 h-3 w-3" />
                          密钥
                        </>
                      )}
                    </Badge>
                    {group && (
                      <Badge
                        variant="outline"
                        className="text-xs"
                        style={{
                          borderColor: group.color,
                          color: group.color,
                        }}
                      >
                        {group.name}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setTestResult(null);
        }}
      >
        <DialogContent className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-6 sm:max-w-[500px]">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {editingId ? "编辑连接" : "新建连接"}
            </DialogTitle>
            <DialogDescription>
              填写 SSH 服务器的连接信息
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3">
            <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  placeholder="My Server"
                  value={form.name}
                  onChange={(e) =>
                    setForm({ ...form, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>分组</Label>
                <Select
                  value={form.groupId ?? "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, groupId: v === "none" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="无分组" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">无分组</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2 space-y-2">
                <Label>主机地址</Label>
                <Input
                  placeholder="192.168.1.1"
                  value={form.host}
                  onChange={(e) =>
                    setForm({ ...form, host: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>端口</Label>
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) =>
                    setForm({ ...form, port: parseInt(e.target.value) || 22 })
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>用户名</Label>
              <Input
                placeholder="root"
                value={form.username}
                onChange={(e) =>
                  setForm({ ...form, username: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>认证方式</Label>
              <Select
                value={form.authType}
                onValueChange={(v: "password" | "key") =>
                  setForm({ ...form, authType: v })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">密码认证</SelectItem>
                  <SelectItem value="key">密钥认证</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.authType === "password" ? (
              <div className="space-y-2">
                <Label>密码</Label>
                <Input
                  type="password"
                  placeholder="输入密码"
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>私钥路径</Label>
                  <Input
                    placeholder="~/.ssh/id_rsa"
                    value={form.privateKey}
                    onChange={(e) =>
                      setForm({ ...form, privateKey: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    输入 SSH 私钥文件的绝对路径，支持 ~ 展开
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>私钥密码（可选）</Label>
                  <Input
                    type="password"
                    placeholder="如果私钥有密码保护"
                    value={form.privateKeyPassphrase}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        privateKeyPassphrase: e.target.value,
                      })
                    }
                  />
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-4 border-t pt-4">
              <div className="space-y-2">
                <Label>Keepalive 间隔（秒）</Label>
                <Input
                  type="number"
                  min={0}
                  max={86400}
                  value={form.keepaliveIntervalSecs}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      keepaliveIntervalSecs: Math.max(
                        0,
                        Math.min(86400, parseInt(e.target.value, 10) || 0)
                      ),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0 表示不发送客户端 keepalive；堡垒机建议 30～120
                </p>
              </div>
              <div className="space-y-2">
                <Label>Keepalive 容忍次数</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.keepaliveMax}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      keepaliveMax: Math.max(
                        0,
                        Math.min(100, parseInt(e.target.value, 10) || 0)
                      ),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  连续多少次无对端数据后断开；0 表示不按次数断开；常用 3
                </p>
              </div>
            </div>
            </div>
            {testResult && (
              <div
                className={`mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                  testResult.ok
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                <span className="break-all">{testResult.message}</span>
              </div>
            )}
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 pt-4">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={!form.host || !form.username || testing}
            >
              {testing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-2 h-4 w-4" />
              )}
              测试连接
            </Button>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={!form.name || !form.host}>
              {editingId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>新建分组</DialogTitle>
            <DialogDescription>创建一个连接分组来组织你的服务器</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>分组名称</Label>
              <Input
                placeholder="production"
                value={groupForm.name}
                onChange={(e) =>
                  setGroupForm({ ...groupForm, name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>颜色</Label>
              <div className="flex gap-2">
                {[
                  "#3b82f6",
                  "#ef4444",
                  "#22c55e",
                  "#f59e0b",
                  "#8b5cf6",
                  "#ec4899",
                  "#06b6d4",
                  "#64748b",
                ].map((color) => (
                  <button
                    key={color}
                    className={`h-8 w-8 rounded-full border-2 transition-transform ${
                      groupForm.color === color
                        ? "border-foreground scale-110"
                        : "border-transparent"
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => setGroupForm({ ...groupForm, color })}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGroupDialogOpen(false)}
            >
              取消
            </Button>
            <Button onClick={handleSaveGroup} disabled={!groupForm.name}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
