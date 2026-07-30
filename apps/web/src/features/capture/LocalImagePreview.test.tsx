import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LocalImagePreview } from "./LocalImagePreview.js";

describe("LocalImagePreview", () => {
  it("creates object URLs after commit and revokes each URL on replacement and unmount", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const first = new Blob(["first"], { type: "image/png" });
    const second = new Blob(["second"], { type: "image/png" });

    const view = render(
      <LocalImagePreview blob={first} alt="first preview" />,
    );
    await waitFor(() => {
      expect(view.container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:first",
      );
    });

    view.rerender(
      <LocalImagePreview blob={second} alt="second preview" />,
    );
    await waitFor(() => {
      expect(view.container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:second",
      );
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

    view.unmount();

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:second");
  });
});
