import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
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
  ChevronDown,
  ChevronRight,
  GripVertical,
  Star,
  Download,
  Upload,
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useAppStore, type ConnectionInfo, type ConnectionGroup } from "@/store";
import {
  canDropConnectionDragPayload,
  canDropGroupDragPayload,
  type ConnectionDragPayload,
  getConnectionAccordionSections,
  groupConnectionsForDisplay,
  isConnectionSortingDisabled,
  moveItemById,
  readCollapsedGroupIds,
  reorderConnectionsWithinGroup,
  writeCollapsedGroupIds,
} from "@/lib/connectionGroups";
import { cn } from "@/lib/utils";

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
  isImportant: boolean;
}

interface ExportConnectionsResult {
  exportedGroups: number;
  exportedConnections: number;
}

interface ImportConnectionsResult {
  importedGroups: number;
  skippedGroups: number;
  importedConnections: number;
  skippedConnections: number;
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
  isImportant: false,
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
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set()
  );
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [dragOverConnectionId, setDragOverConnectionId] = useState<string | null>(
    null
  );
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [transferMessage, setTransferMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const validGroupIds = new Set(groups.map((group) => group.id));
    const next = readCollapsedGroupIds(window.localStorage, validGroupIds);
    setCollapsedGroupIds(next);
    writeCollapsedGroupIds(window.localStorage, next);
  }, [groups]);

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
            isImportant: form.isImportant,
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
            isImportant: form.isImportant,
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
      isImportant: fullConn.isImportant ?? false,
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

  const handleExportConnections = async () => {
    setTransferMessage(null);
    const path = await save({
      defaultPath: `sshx-connections-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "SSHX 连接备份", extensions: ["json"] }],
    });
    if (!path) {
      return;
    }

    setExporting(true);
    try {
      const result = await invoke<ExportConnectionsResult>(
        "export_connections_file",
        { path }
      );
      setTransferMessage({
        ok: true,
        text: `已导出 ${result.exportedConnections} 个连接、${result.exportedGroups} 个分组`,
      });
    } catch (err) {
      setTransferMessage({
        ok: false,
        text: typeof err === "string" ? err : String(err),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleImportConnections = async () => {
    setTransferMessage(null);
    const path = await open({
      multiple: false,
      filters: [{ name: "SSHX 连接备份", extensions: ["json"] }],
    });
    if (typeof path !== "string") {
      return;
    }

    setImporting(true);
    try {
      const result = await invoke<ImportConnectionsResult>(
        "import_connections_file",
        { path }
      );
      setTransferMessage({
        ok: true,
        text: `已导入 ${result.importedConnections} 个连接、${result.importedGroups} 个分组；跳过 ${result.skippedConnections} 个连接、${result.skippedGroups} 个分组`,
      });
      await loadData();
    } catch (err) {
      setTransferMessage({
        ok: false,
        text: typeof err === "string" ? err : String(err),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleToggleImportant = async (conn: ConnectionInfo) => {
    try {
      let fullConn = conn;
      try {
        const detail = await invoke<ConnectionInfo>("get_connection", { id: conn.id });
        if (detail) fullConn = detail;
      } catch {
        // fall back to list data
      }
      await invoke("update_connection", {
        request: {
          id: fullConn.id,
          name: fullConn.name,
          host: fullConn.host,
          port: fullConn.port,
          username: fullConn.username,
          authType: fullConn.authType,
          password: fullConn.authType === "password" ? fullConn.password ?? null : null,
          privateKey: fullConn.authType === "key" ? fullConn.privateKey ?? null : null,
          privateKeyPassphrase:
            fullConn.authType === "key"
              ? fullConn.privateKeyPassphrase ?? null
              : null,
          groupId: fullConn.groupId,
          keepaliveIntervalSecs: fullConn.keepaliveIntervalSecs ?? 30,
          keepaliveMax: fullConn.keepaliveMax ?? 3,
          isImportant: !(fullConn.isImportant ?? false),
        },
      });
      setConnections(
        connections.map((item) =>
          item.id === conn.id
            ? { ...item, isImportant: !(fullConn.isImportant ?? false) }
            : item
        )
      );
    } catch (err) {
      console.error("toggle important error:", err);
      loadData();
    }
  };

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      if (typeof window !== "undefined") {
        writeCollapsedGroupIds(window.localStorage, next);
      }
      return next;
    });
  };

  const handleGroupDrop = async (sourceGroupId: string, targetGroupId: string) => {
    if (sourceGroupId === targetGroupId) {
      return;
    }

    const nextGroups = moveItemById(
      groups,
      sourceGroupId,
      targetGroupId,
      (group) => group.id
    );
    if (nextGroups === groups) {
      return;
    }

    setGroups(nextGroups);
    try {
      await invoke("reorder_groups", {
        request: { groupIds: nextGroups.map((group) => group.id) },
      });
    } catch (err) {
      console.error("reorder groups error:", err);
      loadData();
    }
  };

  const handleConnectionDrop = async (
    sourceConnectionId: string,
    sourceGroupId: string | null,
    targetConnectionId: string,
    targetGroupId: string | null
  ) => {
    if (sourceConnectionId === targetConnectionId || sourceGroupId !== targetGroupId) {
      return;
    }

    const nextConnections = reorderConnectionsWithinGroup(
      connections,
      targetGroupId,
      sourceConnectionId,
      targetConnectionId
    );
    if (nextConnections === connections) {
      return;
    }

    setConnections(nextConnections);
    try {
      await invoke("reorder_connections", {
        request: {
          groupId: targetGroupId,
          connectionIds: nextConnections
            .filter((connection) =>
              targetGroupId === null
                ? connection.groupId === null
                : connection.groupId === targetGroupId
            )
            .map((connection) => connection.id),
        },
      });
    } catch (err) {
      console.error("reorder connections error:", err);
      loadData();
    }
  };

  const getGroupDropTargetId = (x: number, y: number): string | null => {
    const target = document
      .elementFromPoint(x, y)
      ?.closest("[data-connection-group-drop-id]") as HTMLElement | null;
    return target?.dataset.connectionGroupDropId ?? null;
  };

  const getConnectionDropTarget = (
    x: number,
    y: number
  ): { id: string; groupId: string | null } | null => {
    const target = document
      .elementFromPoint(x, y)
      ?.closest("[data-connection-drop-id]") as HTMLElement | null;
    const id = target?.dataset.connectionDropId;
    if (!id) {
      return null;
    }
    const groupId = target.dataset.connectionDropGroupId || null;
    return { id, groupId };
  };

  const startPointerDrag = (
    payload: ConnectionDragPayload,
    e: React.PointerEvent<HTMLElement>
  ) => {
    if (sortingDisabled) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    pointerDragCleanupRef.current?.();

    const handle = e.currentTarget;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Some webviews may not support pointer capture for this element.
    }

    const updateHover = (event: PointerEvent) => {
      if (payload.type === "group") {
        const targetGroupId = getGroupDropTargetId(event.clientX, event.clientY);
        setDragOverGroupId(
          targetGroupId && canDropGroupDragPayload(payload, targetGroupId)
            ? targetGroupId
            : null
        );
        return;
      }

      const target = getConnectionDropTarget(event.clientX, event.clientY);
      setDragOverConnectionId(
        target &&
          canDropConnectionDragPayload(payload, target.groupId, target.id)
          ? target.id
          : null
      );
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", updateHover);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cleanup);
      setDragOverGroupId(null);
      setDragOverConnectionId(null);
      pointerDragCleanupRef.current = null;
    };

    const finish = (event: PointerEvent) => {
      if (payload.type === "group") {
        const targetGroupId = getGroupDropTargetId(event.clientX, event.clientY);
        if (targetGroupId && canDropGroupDragPayload(payload, targetGroupId)) {
          void handleGroupDrop(payload.id, targetGroupId);
        }
      } else {
        const target = getConnectionDropTarget(event.clientX, event.clientY);
        if (
          target &&
          canDropConnectionDragPayload(payload, target.groupId, target.id)
        ) {
          void handleConnectionDrop(
            payload.id,
            payload.groupId,
            target.id,
            target.groupId
          );
        }
      }
      cleanup();
    };

    pointerDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", updateHover);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cleanup);
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
  const connectionSections = groupConnectionsForDisplay(
    filteredConnections,
    groups
  );
  const accordionSections = getConnectionAccordionSections(
    connectionSections,
    collapsedGroupIds
  );
  const sortingDisabled = isConnectionSortingDisabled(search);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">连接管理</h2>
          <p className="text-muted-foreground">管理你的 SSH 连接和分组</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={handleExportConnections}
            disabled={exporting || importing}
          >
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            导出
          </Button>
          <Button
            variant="outline"
            onClick={handleImportConnections}
            disabled={exporting || importing}
          >
            {importing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            导入
          </Button>
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

      {transferMessage && (
        <div
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
            transferMessage.ok
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {transferMessage.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="break-all">{transferMessage.text}</span>
        </div>
      )}

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
        <Accordion>
          {accordionSections.map((section) => {
            const panelId = `connection-group-panel-${section.id}`;
            const SectionChevron = section.isCollapsed
              ? ChevronRight
              : ChevronDown;
            const sectionGroupId =
              section.id === "ungrouped" ? null : section.id;

            return (
              <AccordionItem key={section.id}>
                <div
                  data-connection-group-drop-id={section.id}
                  className={
                    `flex items-center gap-2 rounded-md ${
                      dragOverGroupId === section.id
                        ? "bg-muted/70 ring-1 ring-ring"
                        : ""
                    }`
                  }
                >
                  {section.id !== "ungrouped" &&
                    section.isCollapsed &&
                    !sortingDisabled && (
                      <span
                        role="button"
                        aria-label={`拖动分组 ${section.title}`}
                        className="flex h-7 w-7 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) =>
                          startPointerDrag(
                            { type: "group", id: section.id },
                            e
                          )
                        }
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                    )}
                  <AccordionTrigger
                    contentId={panelId}
                    open={!section.isCollapsed}
                    onClick={() => toggleGroupCollapsed(section.id)}
                    className="min-w-0 flex-1"
                  >
                    <SectionChevron className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {section.color ? (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: section.color }}
                      />
                    ) : (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {section.title}
                    </span>
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {section.connectionCount}
                    </Badge>
                  </AccordionTrigger>
                </div>
                <AccordionContent
                  id={panelId}
                  open={!section.isCollapsed}
                  className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
                >
                  {section.visibleConnections.map((conn) => (
                    <Card
                      key={conn.id}
                      data-connection-drop-id={conn.id}
                      data-connection-drop-group-id={sectionGroupId ?? ""}
                      className={cn(
                        "cursor-pointer transition-shadow",
                        conn.isImportant
                          ? "border-2 border-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.12)] hover:shadow-[0_0_0_3px_rgba(245,158,11,0.16),0_4px_12px_rgba(15,23,42,0.12)]"
                          : "hover:shadow-md",
                        dragOverConnectionId === conn.id && "ring-2 ring-ring"
                      )}
                      onClick={() => handleConnect(conn)}
                    >
                      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                        <div className="flex min-w-0 items-center gap-3">
                          {!sortingDisabled && (
                            <span
                              role="button"
                              aria-label={`拖动连接 ${conn.name}`}
                              className="flex h-8 w-6 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
                              onClick={(e) => e.stopPropagation()}
                              onPointerDown={(e) =>
                                startPointerDrag(
                                  {
                                    type: "connection",
                                    id: conn.id,
                                    groupId: sectionGroupId,
                                  },
                                  e
                                )
                              }
                            >
                              <GripVertical className="h-4 w-4" />
                            </span>
                          )}
                          <div
                            className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                              conn.isImportant ? "bg-amber-100" : "bg-primary/10"
                            )}
                          >
                            <Server
                              className={cn(
                                "h-5 w-5",
                                conn.isImportant ? "text-amber-700" : "text-primary"
                              )}
                            />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="truncate text-base">
                              {conn.name}
                            </CardTitle>
                            <CardDescription className="truncate text-xs">
                              {conn.username}@{conn.host}:{conn.port}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={
                              conn.isImportant
                                ? `取消重点标记 ${conn.name}`
                                : `添加重点标记 ${conn.name}`
                            }
                            className={cn(
                              "h-8 w-8",
                              conn.isImportant
                                ? "bg-amber-500 text-white hover:bg-amber-600 hover:text-white"
                                : "text-muted-foreground hover:text-amber-600"
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleImportant(conn);
                            }}
                          >
                            <Star
                              className={cn(
                                "h-4 w-4",
                                conn.isImportant && "fill-current"
                              )}
                            />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              asChild
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                              >
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
                                  handleToggleImportant(conn);
                                }}
                              >
                                <Star className="mr-2 h-4 w-4" />
                                {conn.isImportant ? "取消重点" : "标为重点"}
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
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="flex items-center gap-2">
                          {conn.isImportant && (
                            <Badge className="bg-amber-500 text-xs text-white hover:bg-amber-500">
                              <Star className="mr-1 h-3 w-3 fill-current" />
                              重点
                            </Badge>
                          )}
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
                          {section.color && (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              style={{
                                borderColor: section.color,
                                color: section.color,
                              }}
                            >
                              {section.title}
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-none px-3">
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
            <div className="rounded-md border border-border p-3">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() =>
                  setForm({ ...form, isImportant: !form.isImportant })
                }
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                      form.isImportant
                        ? "bg-amber-500 text-white"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    <Star
                      className={cn("h-4 w-4", form.isImportant && "fill-current")}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">重点连接</span>
                    <span className="block text-xs text-muted-foreground">
                      开启后连接卡片会使用琥珀色边框突出显示
                    </span>
                  </span>
                </span>
                <span
                  className={cn(
                    "h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                    form.isImportant ? "bg-amber-500" : "bg-muted"
                  )}
                >
                  <span
                    className={cn(
                      "block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                      form.isImportant && "translate-x-4"
                    )}
                  />
                </span>
              </button>
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
