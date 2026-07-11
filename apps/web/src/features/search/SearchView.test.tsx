import type { ItemView, LearningChannel } from "@tenjin/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SearchView } from "./SearchView.js";

function makeItem(options: {
  readonly itemId: string;
  readonly display: string;
  readonly identityKey: string;
  readonly targetChannels: readonly LearningChannel[];
  readonly evidenceCount: number;
  readonly lastOccurredAt: string;
}): ItemView {
  const targets = new Set(options.targetChannels);
  return {
    ...options,
    channels: {
      R: {
        state: targets.has("R") ? "unstable" : "untracked",
        validPassDates: [],
      },
      L: {
        state: targets.has("L") ? "stable" : "untracked",
        validPassDates: [],
      },
      P: {
        state: targets.has("P") ? "unstable" : "untracked",
        validPassDates: [],
      },
    },
  };
}

const ITEMS: readonly ItemView[] = [
  makeItem({
    itemId: "item-z",
    display: "Beta",
    identityKey: "second-key",
    targetChannels: ["P"],
    evidenceCount: 2,
    lastOccurredAt: "2026-07-11T03:00:00.000Z",
  }),
  makeItem({
    itemId: "item-b",
    display: "Alpha",
    identityKey: "hidden-match",
    targetChannels: ["R", "L"],
    evidenceCount: 4,
    lastOccurredAt: "2026-07-11T02:00:00.000Z",
  }),
  makeItem({
    itemId: "item-a",
    display: "Alpha",
    identityKey: "first-key",
    targetChannels: ["R"],
    evidenceCount: 1,
    lastOccurredAt: "2026-07-11T01:00:00.000Z",
  }),
];

describe("SearchView", () => {
  it("shows every item sorted by display and then item ID for an empty query", () => {
    render(<SearchView items={ITEMS} onBack={() => undefined} />);

    expect(screen.getByRole("searchbox", { name: "搜索学习记录" })).toHaveValue("");
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByRole("heading").textContent)).toEqual([
      "Alpha",
      "Alpha",
      "Beta",
    ]);
    expect(rows.map((row) => within(row).getByText(/^证据 /).textContent)).toEqual([
      "证据 1",
      "证据 4",
      "证据 2",
    ]);
  });

  it("searches display and identityKey case-insensitively after trimming", async () => {
    const user = userEvent.setup();
    render(<SearchView items={ITEMS} onBack={() => undefined} />);
    const input = screen.getByRole("searchbox", { name: "搜索学习记录" });

    await user.type(input, "  bEtA  ");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, " HIDDEN-MATCH ");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
  });

  it("shows active channel states, evidence count, and latest evidence time", () => {
    render(<SearchView items={ITEMS} onBack={() => undefined} />);

    const alpha = screen
      .getAllByRole("listitem")
      .find((row) => within(row).queryByText("证据 4") !== null);
    expect(alpha).toBeDefined();
    expect(within(alpha!).getByText("R unstable")).toBeInTheDocument();
    expect(within(alpha!).getByText("L stable")).toBeInTheDocument();
    expect(within(alpha!).queryByText(/^P /)).not.toBeInTheDocument();
    expect(within(alpha!).getByText("证据 4")).toBeInTheDocument();
    expect(
      within(alpha!).getByText("最近 2026-07-11T02:00:00.000Z"),
    ).toBeInTheDocument();
  });

  it("shows a clear empty result and invokes the back action", async () => {
    let wentBack = false;
    const user = userEvent.setup();
    render(
      <SearchView
        items={ITEMS}
        onBack={() => {
          wentBack = true;
        }}
      />,
    );

    await user.type(
      screen.getByRole("searchbox", { name: "搜索学习记录" }),
      "not present",
    );
    expect(screen.getByText("没有找到相关记录")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回记录" }));
    expect(wentBack).toBe(true);
  });
});
