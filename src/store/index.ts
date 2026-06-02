import { create } from "zustand";

export interface ConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string | null;
  privateKey?: string | null;
  privateKeyPassphrase?: string | null;
  groupId: string | null;
  /** 客户端 SSH keepalive 间隔（秒），0 表示关闭 */
  keepaliveIntervalSecs: number;
  /** 未收到对端数据时连续 keepalive 次数上限，达到后断开 */
  keepaliveMax: number;
  createdAt: number;
  updatedAt: number;
}

/** 与后端 `SshClosePayload` 一致 */
export interface SshClosePayload {
  reason: string;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  color: string;
}

export interface TerminalSession {
  id: string;
  connectionId: string;
  connectionName: string;
  active: boolean;
}

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;

  connections: ConnectionInfo[];
  setConnections: (connections: ConnectionInfo[]) => void;
  groups: ConnectionGroup[];
  setGroups: (groups: ConnectionGroup[]) => void;

  sessions: TerminalSession[];
  activeSessionId: string | null;
  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  theme:
    (typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light") as "light" | "dark",
  setTheme: (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    set({ theme });
  },
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === "light" ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next === "dark");
      return { theme: next };
    }),

  connections: [],
  setConnections: (connections) => set({ connections }),
  groups: [],
  setGroups: (groups) => set({ groups }),

  sessions: [],
  activeSessionId: null,
  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    })),
  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      return {
        sessions,
        activeSessionId:
          state.activeSessionId === id
            ? (sessions[sessions.length - 1]?.id ?? null)
            : state.activeSessionId,
      };
    }),
  setActiveSession: (id) => set({ activeSessionId: id }),
}));
