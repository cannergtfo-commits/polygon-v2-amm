"use client";

import { useEffect, useState } from "react";
import { readActivity, type ActivityItem } from "@/lib/activity";
import { scanTx } from "@/lib/registry";
import { shortAddr } from "@/lib/format";

export default function ActivityPage() {
  const [items, setItems] = useState<ActivityItem[]>([]);

  useEffect(() => {
    const load = () => setItems(readActivity());
    load();
    window.addEventListener("blazar-activity", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("blazar-activity", load);
      window.removeEventListener("storage", load);
    };
  }, []);

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>Activity</h2>
        <span>This browser</span>
      </div>
      <p className="note">Hashes you sign from this desk stay in local storage. They are not an account history from the chain.</p>
      {items.length === 0 && <p className="empty">No transactions from this browser yet. A swap, approval, stake, or basket deposit will land here with a Polygonscan link.</p>}
      <ul className="activity">
        {items.map((item) => (
          <li key={item.hash}>
            <b>{item.kind}</b>
            <span>{item.summary}</span>
            <a href={scanTx(item.hash)} target="_blank" rel="noreferrer">
              {shortAddr(item.hash)}
            </a>
            <time>{new Date(item.at).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
