import type { ItemView, LearningChannel } from "@tenjin/core";
import { useState } from "react";

export interface SearchViewProps {
  readonly items: readonly ItemView[];
  readonly onBack: () => void;
}

const CHANNELS: readonly LearningChannel[] = ["R", "L", "P"];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function SearchView({ items, onBack }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const results = items
    .filter(
      (item) =>
        normalizedQuery.length === 0 ||
        item.display.toLowerCase().includes(normalizedQuery) ||
        item.identityKey.toLowerCase().includes(normalizedQuery),
    )
    .sort(
      (left, right) =>
        compareStrings(left.display, right.display) ||
        compareStrings(left.itemId, right.itemId),
    );

  return (
    <section className="utility-view search-view" aria-labelledby="search-title">
      <button className="back-action" type="button" onClick={onBack}>
        返回记录
      </button>
      <h1 id="search-title">搜索</h1>
      <label htmlFor="ledger-search">搜索学习记录</label>
      <input
        className="search-input"
        id="ledger-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />

      {results.length === 0 ? (
        <p className="empty-state">没有找到相关记录</p>
      ) : (
        <ul className="evidence-list">
          {results.map((item) => (
            <li key={item.itemId}>
              <article>
                <h2>{item.display}</h2>
                <div className="channel-state" aria-label={`${item.display} 通道状态`}>
                  {CHANNELS.filter(
                    (channel) => item.channels[channel].state !== "untracked",
                  ).map((channel) => (
                    <p key={channel}>
                      {channel} {item.channels[channel].state}
                    </p>
                  ))}
                </div>
                <p>证据 {item.evidenceCount}</p>
                <p>最近 {item.lastOccurredAt}</p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
