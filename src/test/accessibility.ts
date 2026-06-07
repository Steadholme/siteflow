import { within } from "@testing-library/react";
import { expect } from "vitest";

type TestContainer = HTMLElement | DocumentFragment;

function getElementContainer(container: TestContainer): HTMLElement {
  return container instanceof HTMLElement ? container : document.body;
}

export async function expectPrimaryHeading(name?: string | RegExp, container: TestContainer = document.body) {
  const scope = within(getElementContainer(container));
  const heading = name ? await scope.findByRole("heading", { level: 1, name }) : await scope.findByRole("heading", { level: 1 });

  expect(heading).toBeVisible();
  return heading;
}

export function expectHeadingStructure(container: TestContainer = document.body) {
  const headings = Array.from(getElementContainer(container).querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const h1Count = headings.filter((heading) => heading.tagName === "H1").length;

  expect(h1Count).toBe(1);

  let previousLevel = 0;
  for (const heading of headings) {
    const currentLevel = Number(heading.tagName.slice(1));

    if (previousLevel > 0) {
      expect(currentLevel - previousLevel, `heading level jumps at ${heading.textContent ?? heading.tagName}`).toBeLessThanOrEqual(1);
    }

    previousLevel = currentLevel;
  }
}

export function expectStatusPillsHaveText(container: TestContainer = document.body) {
  const pills = Array.from(getElementContainer(container).querySelectorAll<HTMLElement>(".status-pill"));

  expect(pills.length).toBeGreaterThan(0);
  for (const pill of pills) {
    expect(pill).toHaveTextContent(/\S/);
    expect(pill.dataset.status).toMatch(/^(success|warning|error|info)$/);
  }
}

export function expectIconButtonsHaveNames(container: TestContainer = document.body) {
  const iconButtons = Array.from(getElementContainer(container).querySelectorAll<HTMLButtonElement>("button.icon-button"));

  for (const button of iconButtons) {
    expect(button).toHaveAccessibleName(/\S/);
  }
}

export function expectFocusableControlsHaveNames(container: TestContainer = document.body) {
  const controls = Array.from(
    getElementContainer(container).querySelectorAll<HTMLElement>("a[href], button, input, select, textarea")
  ).filter((element) => !element.hasAttribute("hidden"));

  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control).toHaveAccessibleName(/\S/);
  }
}

export function expectElementCanReceiveFocus(element: HTMLElement) {
  element.focus();
  expect(element).toHaveFocus();
}
