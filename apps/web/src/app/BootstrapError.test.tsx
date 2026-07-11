import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { BootstrapError } from "./BootstrapError.js";

describe("BootstrapError", () => {
  it("renders a recoverable local-ledger error instead of a blank root", async () => {
    let retries = 0;
    const user = userEvent.setup();
    render(
      <BootstrapError
        error={new Error("IndexedDB unavailable")}
        onRetry={() => {
          retries += 1;
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Tenjin" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "IndexedDB unavailable",
    );
    await user.click(screen.getByRole("button", { name: "重新打开" }));
    expect(retries).toBe(1);
  });
});
