import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { DEFAULT_TERMINAL_SCROLLBACK_LINES } from "@/lib/terminalConfig";

interface UseTerminalOptions {
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: "block" | "underline" | "bar";
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function useTerminal(options: UseTerminalOptions = {}) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const {
    fontSize = 14,
    fontFamily = "Menlo, Monaco, 'Courier New', monospace",
    cursorStyle = "block",
    onData,
    onResize,
  } = options;

  const initTerminal = useCallback(
    (container: HTMLDivElement) => {
      if (termRef.current) {
        termRef.current.dispose();
      }

      const term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily,
        cursorStyle,
        scrollback: DEFAULT_TERMINAL_SCROLLBACK_LINES,
        theme: {
          background: "#1e1e2e",
          foreground: "#cdd6f4",
          cursor: "#f5e0dc",
          selectionBackground: "#585b7066",
          black: "#45475a",
          red: "#f38ba8",
          green: "#a6e3a1",
          yellow: "#f9e2af",
          blue: "#89b4fa",
          magenta: "#f5c2e7",
          cyan: "#94e2d5",
          white: "#bac2de",
          brightBlack: "#585b70",
          brightRed: "#f38ba8",
          brightGreen: "#a6e3a1",
          brightYellow: "#f9e2af",
          brightBlue: "#89b4fa",
          brightMagenta: "#f5c2e7",
          brightCyan: "#94e2d5",
          brightWhite: "#a6adc8",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        term.loadAddon(webglAddon);
      } catch {
        // WebGL not available, fall back to canvas renderer
      }

      term.open(container);
      fitAddon.fit();

      if (onData) {
        term.onData(onData);
      }

      if (onResize) {
        term.onResize(({ cols, rows }) => onResize(cols, rows));
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      containerRef.current = container;

      return term;
    },
    [fontSize, fontFamily, cursorStyle, onData, onResize]
  );

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  const write = useCallback((data: string | Uint8Array) => {
    termRef.current?.write(data);
  }, []);

  const dispose = useCallback(() => {
    termRef.current?.dispose();
    termRef.current = null;
    fitAddonRef.current = null;
  }, []);

  useEffect(() => {
    const handleResize = () => fit();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [fit]);

  return {
    termRef,
    fitAddonRef,
    initTerminal,
    fit,
    write,
    dispose,
  };
}
