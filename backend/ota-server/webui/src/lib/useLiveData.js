import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api.js";

const STALE_DEFAULT = 15;

export function useLiveData() {
  const [rooms, setRooms] = useState([]);
  const [colorScale, setColorScale] = useState({ min: -10, max: 15 });
  const [staleAfter, setStaleAfter] = useState(STALE_DEFAULT);
  const [latest, setLatest] = useState({});
  const [history, setHistory] = useState({});
  const [connected, setConnected] = useState(false);
  const [rangeMin, setRangeMin] = useState(60);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [selectedSensor, setSelectedSensor] = useState(null);

  const rangeRef = useRef(rangeMin);
  rangeRef.current = rangeMin;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api("/api/fridges");
        if (!alive) return;
        const rs = (data.rooms || []).map((r) => ({
          ...r,
          thresholds: {
            target_min: r.thresholds?.target_min,
            target_max: r.thresholds?.target_max,
            warn_max: r.thresholds?.warn,
            alarm_max: r.thresholds?.alarm,
          },
        }));
        setRooms(rs);
        setColorScale(data.color_scale || { min: -10, max: 15 });
        setStaleAfter(data.stale_after_s || STALE_DEFAULT);
        if (!selectedRoom && rs[0]) setSelectedRoom(rs[0].id);
      } catch (e) {
        console.error("fridges", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedRoom]);

  const loadHistory = useCallback(async (roomId, minutes) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;
    const ids = (room.sensors || []).map((s) => s.id).join(",");
    if (!ids) return;
    try {
      const data = await api(
        `/api/readings/history?ids=${encodeURIComponent(ids)}&minutes=${minutes}&points=600`
      );
      const series = data.series || {};
      const h = {};
      for (const s of room.sensors || []) {
        h[s.id] = (series[s.id] || []).map((r) => [r[0], r[1]]);
      }
      setHistory(h);
    } catch (e) {
      /* keep previous */
    }
  }, [rooms]);

  useEffect(() => {
    if (selectedRoom) loadHistory(selectedRoom, rangeMin);
  }, [selectedRoom, rangeMin, loadHistory]);

  // Live stream (SSE) — appends to latest + history.
  useEffect(() => {
    let es;
    const connect = () => {
      es = new EventSource("/api/stream");
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.onmessage = (ev) => {
        try {
          const s = JSON.parse(ev.data);
          if (!s || !s.sensor_id) return;
          const t = Date.now();
          setLatest((prev) => ({
            ...prev,
            [s.sensor_id]: { temp: s.temp, resistance: s.resistance, fault: s.fault, time: t },
          }));
          setHistory((prev) => {
            const arr = prev[s.sensor_id] ? prev[s.sensor_id].slice() : [];
            arr.push([t, s.temp]);
            const cutoff = t - rangeRef.current * 60000;
            while (arr.length && arr[0][0] < cutoff) arr.shift();
            return { ...prev, [s.sensor_id]: arr };
          });
        } catch (e) {
          /* ignore */
        }
      };
    };
    connect();
    return () => es && es.close();
  }, []);

  // Polling fallback for /api/readings/latest.
  useEffect(() => {
    let last = 0;
    const iv = setInterval(async () => {
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      try {
        const data = await api("/api/readings/latest");
        const map = data.readings || {};
        setLatest((prev) => {
          const next = { ...prev };
          for (const [id, v] of Object.entries(map)) {
            const tt = typeof v.time === "number" ? v.time : v.time ? Date.parse(v.time) : now;
            if (!next[id] || tt > next[id].time)
              next[id] = { temp: v.temp, resistance: v.resistance, fault: v.fault, time: tt };
          }
          return next;
        });
        setConnected(true);
      } catch (e) {
        setConnected(false);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  const isStale = useCallback(
    (id) => {
      const r = latest[id];
      return !r || r.time == null || Date.now() - r.time > staleAfter * 1000;
    },
    [latest, staleAfter]
  );

  const currentRoom = rooms.find((r) => r.id === selectedRoom) || null;

  return {
    rooms,
    colorScale,
    staleAfter,
    latest,
    history,
    connected,
    rangeMin,
    setRangeMin,
    selectedRoom,
    setSelectedRoom,
    selectedSensor,
    setSelectedSensor,
    isStale,
    currentRoom,
  };
}
