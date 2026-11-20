"use client";

import { useEffect, useRef, useState } from "react";
import type { EventDTO, ServerMessage } from "@/lib/live/types";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "signed-out";

type Options = {
  /** Highest event id the page already has; sent as `resume` so missed events are backfilled. */
  getLastEventId: () => number;
  onEvents: (events: EventDTO[]) => void;
  /** Called after a reconnect (not the first connect) so the caller can resync aggregates. */
  onReconnect?: () => void;
};

export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(15_000, 1000 * 2 ** attempt);
  return Math.round(base / 2 + (random() * base) / 2);
}

export function useLiveEvents({ getLastEventId, onEvents, onReconnect }: Options): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const handlers = useRef({ getLastEventId, onEvents, onReconnect });

  useEffect(() => {
    handlers.current = { getLastEventId, onEvents, onReconnect };
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let connectedOnce = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: "resume", lastEventId: handlers.current.getLastEventId() }));
      };
      ws.onmessage = (msg) => {
        const data = JSON.parse(String(msg.data)) as ServerMessage;
        if (data.type === "ready") {
          setStatus("live");
          if (connectedOnce) handlers.current.onReconnect?.();
          connectedOnce = true;
          attempt = 0;
        } else if (data.type === "event") {
          handlers.current.onEvents([data.event]);
        } else if (data.type === "backfill") {
          if (data.events.length) handlers.current.onEvents(data.events);
          if (data.truncated) handlers.current.onReconnect?.();
        }
      };
      ws.onclose = (ev) => {
        if (stopped) return;
        if (ev.code === 4401) {
          setStatus("signed-out");
          return;
        }
        setStatus("reconnecting");
        timer = setTimeout(connect, backoffDelay(attempt++));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return status;
}
