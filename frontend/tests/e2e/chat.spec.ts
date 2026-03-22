import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function sendComposerMessage(page: Page, content: string) {
  const textarea = page.locator("textarea");
  await textarea.evaluate((element, value) => {
    const target = element as HTMLTextAreaElement;
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }, content);
  await expect(page.getByRole("button", { name: /Send message/i })).toBeEnabled();
  await page.getByRole("button", { name: /Send message/i }).click();
}

test("first message renders immediately and persists after refresh", async ({ page }) => {
  const prompt = `E2E flow ${Date.now()} explain the backend chat flow`;

  await page.goto("/chat");
  await sendComposerMessage(page, prompt);

  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
  await expect(page.getByText(prompt)).toBeVisible();
  await expect(
    page.getByText(/persisted backend chat flow/i)
  ).toBeVisible({ timeout: 15000 });

  await page.reload();

  await expect(page.getByText(prompt)).toBeVisible();
  await expect(page.getByText(/persisted backend chat flow/i)).toBeVisible();
});

test("sidebar rename and delete actions persist", async ({ page }) => {
  const prompt = `Rename me ${Date.now()} conversation`;
  const renamedTitle = `Renamed thread ${Date.now()}`;

  await page.goto("/chat");
  await sendComposerMessage(page, prompt);
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);

  const row = page.locator("aside").getByText(prompt).first();
  await row.hover();
  await page
    .getByRole("button", { name: new RegExp(`Conversation actions for ${prompt}`) })
    .click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.locator("aside input").fill(renamedTitle);
  await page.locator("aside input").press("Enter");

  await expect(page.getByText(renamedTitle).first()).toBeVisible();
  await expect(page.getByRole("banner").getByText(renamedTitle)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("banner").getByText(renamedTitle)).toBeVisible();

  const renamedRow = page.locator("aside").getByText(renamedTitle).first();
  await renamedRow.hover();
  await page
    .getByRole("button", { name: new RegExp(`Conversation actions for ${renamedTitle}`) })
    .click();
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete conversation" }).click();

  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText(renamedTitle)).toHaveCount(0);
});

test("assistant markdown renders headings, code, tables, quotes, and links", async ({
  page,
}) => {
  const prompt = `markdown demo ${Date.now()} with code block and table`;

  await page.goto("/chat");
  await sendComposerMessage(page, prompt);
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);

  await expect(
    page.getByRole("heading", { name: "PremChat Markdown Demo" })
  ).toBeVisible({ timeout: 15000 });
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy/i }).first()).toBeVisible();
  await expect(page.getByText(/Good formatting makes technical output readable/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /OpenRouter/i })).toBeVisible();
});
