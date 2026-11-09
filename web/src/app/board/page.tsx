"use client";

import { useEffect, useState } from "react";
import { registry } from "@/lib/registry";

type Board = {
  generatedAt?: string | null;
  note?: string;
  days?: { dayId: string; traders: { address: string; volumeUsd: number; points: number; rewardBzb: string; rewarded?: boolean }[] }[];
};

export default function BoardPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shares = registry.points.shareBps;

  useEffect(() => {
    fetch("/api/board")
      .then((response) => response.json())
      .then(setBoard)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <section className="panel wide">
      <div className="panel-head">
        <h2>Daily board</h2>
        <span>Top 50 listed · top 25 paid</span>
      </div>
      <p>
        One point per counted dollar. A trade under ${registry.points.minTradeUsd} does not score. A wallet can only count ${registry.points.walletDailyCapUsd.toLocaleString()} a day. Round trips inside {registry.points.roundTripWindowSec / 60} minutes score the net, not both sides. The aggregator fee plus the pool fee is the expensive part of washing a pool.
      </p>
      <div className="weights">
        {shares.map((weight, index) => (
          <div key={`${index}-${weight}`}>
            <b>#{index + 1}</b>
            <span>{(weight / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%</span>
          </div>
        ))}
      </div>
      <p className="note">
        The poster {registry.points.poster} posts yesterday&apos;s top 25 into BlazarDailyRewards. The desk lists 50. Ranks 26–50 are shown and not paid. A missing rank does not increase anyone else&apos;s share, so unpaid BZB stays in the pot. The cap is 1000 BZB a day. The owner can rotate the poster, pause, and emergency-withdraw. The poster cannot.
      </p>
      {error && <p className="warn">{error}</p>}
      {!board?.days?.length && <p className="empty">{board?.note ?? "The board is empty until the fee router emits swaps and the indexer runs."}</p>}
      {board?.days?.map((day) => (
        <article key={day.dayId} className="day">
          <h3>Day {day.dayId}</h3>
          <ol>
            {day.traders.map((trader, index) => (
              <li key={trader.address}>
                <b>#{index + 1}</b> {trader.address} · ${trader.volumeUsd.toFixed(2)} · {trader.points} pts
                {trader.rewarded ? " · paid" : " · listed only"}
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}
