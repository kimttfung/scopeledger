import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("renders agreement and readiness facts from the PostgreSQL projection", async ({
  page,
}) => {
  await page.route("**/api/demo/review", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        unitId: "unit-u1",
        currentVersion: 2,
        acceptedVersion: null,
        readiness: "review-hold",
        holds: [{
          reason: "correction",
          concernId: "layout-concern",
        }],
        workStartRecorded: false,
      }),
    });
  });
  await page.reload();
  await expect(page.getByText("PostgreSQL-backed demo")).toBeVisible();
  await expect(page.locator(".prototype-notice")).toContainText(
    "Agreement facts are read from local PostgreSQL",
  );
  await expect(page.locator(".status-grid")).toContainText(
    "Client concern requires exact decision",
  );
  await expect(page.locator(".status-grid")).toContainText("Not recorded");
});

test("records an exact approval only after verified client access and preview", async ({
  page,
}) => {
  let decisionRecorded = false;
  await page.route("**/api/demo/review", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        unitId: "unit-u1",
        currentVersion: 2,
        acceptedVersion: decisionRecorded ? 2 : null,
        readiness: decisionRecorded ? "awaiting-payment" : "review-hold",
        holds: decisionRecorded ? [] : [{
          reason: "correction",
          concernId: "layout-concern",
        }],
        workStartRecorded: false,
      }),
    });
  });
  await page.route("**/api/access/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        verified: true,
        role: "client-approver",
      }),
    });
  });
  await page.route("**/api/demo/decision", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as {
      decision: string;
      reviewedResponse: boolean;
      authority: boolean;
    };
    expect(body).toEqual({
      decision: "approve",
      reviewedResponse: true,
      authority: true,
    });
    decisionRecorded = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        recorded: true,
        unitId: "unit-u1",
        version: 2,
        decision: "approve",
        agreementStatus: "approved",
        obligationCreated: true,
        paymentStatus: "not-initiated",
      }),
    });
  });

  await page.reload();
  await page.getByRole("checkbox", {
    name: /I have read the studio response/,
  }).check();
  await page.getByRole("checkbox", {
    name: /I am authorized to decide/,
  }).check();
  await page.getByRole("button", {
    name: "Resolve concern and approve these terms",
  }).click();
  await page.getByRole("button", {
    name: "Record this approval",
  }).click();
  await expect(page.getByText("Approval recorded for unit-u1")).toBeVisible();
  await expect(page.locator(".status-grid")).toContainText("Approved");
  await expect(page.locator(".status-grid")).toContainText("Awaiting payment");
  await expect(page.getByText("no payment was initiated")).toBeVisible();
});

test("verifies a local client channel without implying authority", async ({
  page,
}) => {
  await page.route("**/api/access/session", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ verified: false }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ verified: false }),
      });
    }
  });
  await page.route("**/api/access/request", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "11111111-1111-4111-8111-111111111111",
        expiresAt: "2026-11-11T12:10:00Z",
        inboxUrl: "http://127.0.0.1:8025",
        previewUrl: "/email-preview/message-id",
      }),
    });
  });
  await page.route("**/api/access/verify", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        verified: true,
        role: "client-approver",
        expiresAt: "2026-11-11T12:30:00Z",
      }),
    });
  });

  await page.goto("/access-demo");
  await page.getByRole("button", {
    name: "Send local verification code",
  }).click();
  await expect(page.getByRole("status")).toContainText(
    "Verification code sent",
  );
  await expect(page.getByRole("link", {
    name: "Preview rendered email",
  })).toHaveAttribute("href", "/email-preview/message-id");
  await page.getByRole("textbox", { name: "Six-digit code" }).fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page.getByText("Local channel verified: client-approver")).toBeVisible();
  await expect(page.getByText("does not prove legal authority")).toBeVisible();
  await expect(page.getByText("authorize money")).toBeVisible();
});

test("keeps provider access disabled until Auth0 is configured", async ({
  page,
}) => {
  await page.goto("/provider");
  await expect(
    page.getByRole("heading", {
      name: "Provider access is not configured",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Authentication unavailable in this profile",
  );
  await expect(page.getByText("synthetic client-review prototype")).toBeVisible();
});

test("keeps PayPal return and cancellation honest until server verification", async ({
  page,
}) => {
  await page.goto("/payments/paypal/return?token=synthetic-order");
  await expect(
    page.getByRole("heading", { name: "Back from PayPal", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Payment verification pending",
  );
  await expect(page.getByRole("status")).toContainText(
    "must verify the original Order",
  );
  await expect(page.getByText("payment completed", { exact: false })).toBeVisible();

  await page.goto("/payments/paypal/cancel?token=synthetic-order");
  await expect(
    page.getByRole("heading", {
      name: "PayPal approval was not completed here",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "No payment result inferred",
  );
  await expect(
    page.getByRole("link", { name: "Return to request review", exact: true }),
  ).toHaveAttribute("href", "/");
});

test("keeps historical scope out of the exact current terms", async ({ page }) => {
  await expect(page.locator("#changes")).toContainText("USD 450.00");
  await expect(page.locator("#changes")).toContainText("Superseded; not actionable");
  await expect(page.locator("#terms")).toContainText("USD 300.00");
  await expect(page.locator("#terms")).not.toContainText("USD 450.00");
  await expect(page.getByRole("button", { name: /pay now|pay all|approve all/i })).toHaveCount(0);
});

test("requires both acknowledgments and restores focus after a preview", async ({ page }) => {
  const approve = page.getByRole("button", { name: "Resolve concern and approve these terms", exact: true });
  const decline = page.getByRole("button", { name: "Resolve concern and decline this offer", exact: true });
  await expect(approve).toBeDisabled();
  await expect(decline).toBeDisabled();
  await page.getByRole("checkbox", { name: /I have read the studio response/ }).check();
  await expect(approve).toBeDisabled();
  await page.getByRole("checkbox", { name: /I am authorized to decide/ }).check();
  await expect(approve).toBeEnabled();
  await expect(decline).toBeEnabled();
  await approve.click();
  await expect(page.getByRole("dialog")).toContainText("Nothing is approved, declined, sent, resolved, or charged");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(approve).toBeFocused();
});

test("previews either decision without changing agreement or payment facts", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  await page.getByRole("checkbox", { name: /I have read the studio response/ }).check();
  await page.getByRole("checkbox", { name: /I am authorized to decide/ }).check();
  await page.getByRole("button", { name: "Resolve concern and decline this offer", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("This outcome declines the version 2 offer");
  await page.getByRole("button", { name: "Return to review", exact: true }).click();
  await page.getByRole("button", { name: "Decline and keep my concern open", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("leaving your concern open");
  await page.keyboard.press("Escape");
  await expect(page.locator(".status-grid")).toContainText("Awaiting decision");
  await expect(page.locator(".status-grid")).toContainText("Unavailable until approval");
  expect(writes).toEqual([]);
});

test("opens real source and historical disclosures", async ({ page }) => {
  await page.getByRole("button", { name: "View source context", exact: true }).click();
  await expect(page.locator("details").nth(0)).toHaveAttribute("open", "");
  await expect(page.locator("details").nth(0)).toContainText("No AI analysis");
  await page.getByRole("button", { name: /View version 1 as a historical record/ }).click();
  await expect(page.locator("details").nth(1)).toHaveAttribute("open", "");
  await expect(page.locator("details").nth(1)).toContainText("There is no decision or payment action for version 1");
});

test("validates a question and keeps model processing optional", async ({ page }) => {
  await page.getByRole("button", { name: "Ask a question", exact: true }).click();
  await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
  await expect(page.locator(".message-form").getByRole("alert")).toContainText("Add a question");
  const question = page.getByRole("textbox", { name: "Your question", exact: true });
  await expect(question).toBeFocused();
  await question.fill("Was the reusable layout already included?");
  await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Not permitted. Manual review remains available.");
  await expect(page.getByRole("dialog")).toContainText("creates no record or hold");
});

test("preserves an in-tab draft while allowing unavailable-source correction", async ({ page }) => {
  const questionButton = page.getByRole("button", { name: "Ask a question", exact: true });
  await questionButton.click();
  await page.getByRole("textbox", { name: "Your question", exact: true }).fill("The layout was already agreed.");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(questionButton).toBeFocused();
  await page.getByRole("button", { name: "I believe this was already agreed", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /What do you believe was already agreed/ })).toHaveValue("The layout was already agreed.");
  await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Unavailable; no attachment supplied.");
  await expect(page.getByRole("dialog")).toContainText("Nothing is approved");
});

test("keeps meaningful content within 320px and supports reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const size = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport);
  await expect(page.getByRole("heading", { name: "Review this request", exact: true })).toBeVisible();
  await expect(page.locator("#terms")).toContainText("Full payment through PayPal after approval");
});

for (const field of ["message", "source"] as const) {
  test(`${field} preserves Unicode input and enforces the exact code-point boundary`, async ({ page }) => {
    await page.getByRole("button", { name: "I believe this was already agreed", exact: true }).click();
    const message = page.getByRole("textbox", { name: /What do you believe was already agreed/ });
    const input = field === "message"
      ? message
      : page.getByRole("textbox", { name: /Source or explanation/ });
    const note = page.locator(field === "message" ? "#draft-note" : "#source-note");
    const error = page.locator(field === "message" ? "#message-error" : "#source-error");
    if (field === "source") await message.fill("The reusable layout was already included.");

    await input.fill("😀".repeat(6000));
    expect(Array.from(await input.inputValue())).toHaveLength(6000);
    await expect(note).toContainText("6,000 / 10,000");
    await input.fill("A".repeat(9999) + "😀");
    expect(Array.from(await input.inputValue())).toHaveLength(10000);
    await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    const overLimit = "A".repeat(10000) + "😀";
    await input.fill(overLimit);
    await expect(input).toHaveValue(overLimit);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(note).toContainText("10,001 / 10,000");
    await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(error).toContainText("Shorten it before previewing; your text has been kept.");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(overLimit);

    await input.fill("修正された約束 — تم الاتفاق — 😀");
    await expect(input).toHaveAttribute("aria-invalid", "false");
    await expect(error).toHaveCount(0);
    await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("修正された約束 — تم الاتفاق — 😀");
  });
}

test("wraps a long source at 320px without truncating its text or line breaks", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.getByRole("button", { name: "I believe this was already agreed", exact: true }).click();
  await page.getByRole("textbox", { name: /What do you believe was already agreed/ }).fill("The layout was already included.");
  const source = "  https://example.test/" + "A".repeat(240) + "\nAccepted email excerpt.  ";
  const sourceInput = page.getByRole("textbox", { name: /Source or explanation/ });
  await sourceInput.fill(source);
  await expect(sourceInput).toHaveValue(source);
  await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const widths = await dialog.evaluate((element) => ({
    client: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.client);
  expect(await dialog.locator(".source-preview").textContent()).toBe("Source: " + source);
  await expect(page.locator(".status-grid")).toContainText("Awaiting decision");
});

test("keeps background position when scrolling past short or long dialog boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.getByRole("button", { name: "Ask a question", exact: true }).click();
  await page.getByRole("textbox", { name: "Your question", exact: true }).fill("A synthetic question.\n".repeat(80));
  await page.getByRole("button", { name: "Preview what would be shared", exact: true }).click();

  for (const kind of ["long", "short"]) {
    if (kind === "short") {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Decline and keep my concern open", exact: true }).click();
    }
    const dialog = page.getByRole("dialog");
    await page.evaluate(() => window.scrollTo(0, 600));
    const backgroundY = await page.evaluate(() => window.scrollY);
    const box = await dialog.boundingBox();
    if (!box) throw new Error("The preview dialog must be visible.");
    await page.mouse.move(box.x + box.width / 2, box.y + 40);

    for (const direction of [-1, 1]) {
      await dialog.evaluate((element, value) => {
        element.scrollTop = value < 0 ? 0 : element.scrollHeight;
      }, direction);
      await page.mouse.wheel(0, direction * 600);
      // Wheel scrolling is committed asynchronously by the browser.
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY)).toBe(backgroundY);
    }
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Decline and keep my concern open", exact: true })).toBeFocused();
});

test("keeps standalone controls and label hit areas at least 44px across viewport sizes", async ({ page }) => {
  await page.getByRole("button", { name: "View source context", exact: true }).click();
  await page.getByRole("button", { name: /View version 1 as a historical record/ }).click();
  await page.getByRole("button", { name: "I believe this was already agreed", exact: true }).click();

  for (const width of [320, 390, 768, 1024, 1280, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    const undersized = await page.locator("a, button, input, textarea, summary").evaluateAll((elements) =>
      elements.filter((element) =>
        element.checkVisibility()
        && element.getAttribute("aria-label") !== "Open Next.js Dev Tools"
      ).map((element) => {
        const target = element.matches('input[type="checkbox"]')
          ? element.closest("label") ?? element
          : element;
        const bounds = target.getBoundingClientRect();
        return {
          name: element.getAttribute("aria-label") || target.textContent?.trim().slice(0, 80) || element.id,
          width: bounds.width,
          height: bounds.height,
        };
      }).filter((target) => target.width < 44 || target.height < 44),
    );
    expect(undersized, `Touch target minimum at ${width}px`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    for (const selector of [".section-nav a", ".alternative-actions button", ".attestations label"]) {
      const overlaps = await page.locator(selector).evaluateAll((elements) => {
        const boxes = elements.map((element) => element.getBoundingClientRect());
        return boxes.some((a, index) => boxes.slice(index + 1).some((b) =>
          Math.min(a.right, b.right) > Math.max(a.left, b.left)
          && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
        ));
      });
      expect(overlaps, `${selector} targets must not overlap at ${width}px`).toBe(false);
    }
  }
});

test("supports touch and pointer use in phone, landscape, and wide touch contexts", async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error("The UI suite requires its configured local base URL.");
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1280, height: 800 },
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(baseURL);
      await page.getByRole("link", { name: "Exact terms", exact: true }).tap();
      await expect(page).toHaveURL(/#terms$/);
      await page.getByRole("button", { name: "View source context", exact: true }).tap();
      await expect(page.locator("details").nth(0)).toHaveAttribute("open", "");

      const authorityLabel = page.locator(".attestations label").nth(1);
      const bounds = await authorityLabel.boundingBox();
      if (!bounds) throw new Error("The authority acknowledgment must be visible.");
      await authorityLabel.tap({ position: { x: bounds.width - 4, y: bounds.height - 4 } });
      await expect(page.getByRole("checkbox", { name: /I am authorized to decide/ })).toBeChecked();
      await expect(page.getByRole("button", { name: "Resolve concern and approve these terms", exact: true })).toBeDisabled();

      await page.getByRole("button", { name: "Ask a question", exact: true }).tap();
      await expect(page.getByRole("textbox", { name: "Your question", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "Close", exact: true }).tap();
      await page.getByRole("link", { name: "What changed", exact: true }).click();
      await expect(page).toHaveURL(/#changes$/);
    } finally {
      await context.close();
    }
  }
});

test("keeps disclosure feedback and numeric helper styling consistent", async ({ page }) => {
  const summary = page.locator(".record-details summary").first();
  await summary.hover();
  const hovered = await summary.evaluate((element) => ({
    color: getComputedStyle(element).color,
    decoration: getComputedStyle(element).textDecorationLine,
  }));
  expect(hovered.color).toBe("rgb(23, 57, 185)");
  expect(hovered.decoration).toContain("underline");
  await page.mouse.down();
  try {
    expect(await summary.evaluate((element) => element.matches(":active"))).toBe(true);
    await expect(summary).toHaveCSS("color", "rgb(23, 57, 185)");
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator("details").nth(0)).toHaveAttribute("open", "");

  await page.getByRole("button", { name: "Ask a question", exact: true }).click();
  await page.getByRole("textbox", { name: "Your question", exact: true }).fill("Is this already included?");
  await expect(page.locator("#draft-note")).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(page.locator("#draft-note")).toContainText("25 / 10,000");
});
