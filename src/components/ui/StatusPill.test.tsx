import { render, screen } from "@testing-library/react";

import { StatusPill, type StatusTone } from "@components/ui/StatusPill";

const cases: Array<{ tone: StatusTone; label: string }> = [
  { tone: "success", label: "Healthy" },
  { tone: "warning", label: "Pending" },
  { tone: "error", label: "Failed" },
  { tone: "info", label: "Verifying" }
];

describe("StatusPill", () => {
  it.each(cases)("renders $tone status text with a semantic CSS class", ({ tone, label }) => {
    render(<StatusPill tone={tone}>{label}</StatusPill>);

    const pill = screen.getByText(label);
    expect(pill).toBeVisible();
    expect(pill).toHaveClass("status-pill", `status-pill--${tone}`);
    expect(pill).toHaveAttribute("data-status", tone);
  });
});
