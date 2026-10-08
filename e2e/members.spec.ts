import { expect, test, type Browser, type Page } from "@playwright/test";

// Members and invitations end to end: real pages, server actions, Better Auth and the
// database, on the production build (no email provider configured → links are shared
// manually, and the UI must say that no email was sent).

const PASSWORD = "correct horse battery";
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Locale = "ar" | "en";

async function signUpAndSignIn(page: Page, locale: Locale, email: string, name: string) {
  await page.goto(`/${locale}/sign-up`);
  await page.fill("#sign-up-name", name);
  await page.fill("#sign-up-email", email);
  await page.fill("#sign-up-password", PASSWORD);
  await page.getByTestId("sign-up-submit").click();
  await expect(page).toHaveURL(`/${locale}/sign-in?registered=1`);
  await page.fill("#sign-in-email", email);
  await page.fill("#sign-in-password", PASSWORD);
  await page.getByTestId("sign-in-submit").click();
  await expect(page).toHaveURL(`/${locale}/workspaces/new`);
}

async function ownerWithWorkspace(browser: Browser, locale: Locale) {
  const page = await browser.newPage();
  const slug = `team-${tag()}`;
  await signUpAndSignIn(page, locale, `e2e-owner-${tag()}@example.com`, "Owner");
  await page.fill("#workspace-name", `Team ${slug}`);
  await page.fill("#workspace-slug", slug);
  await page.getByTestId("create-workspace-submit").click();
  await expect(page).toHaveURL(`/${locale}/w/${slug}`);
  return { page, slug };
}

async function invite(page: Page, email: string, role: string) {
  await page.fill("#invite-email", email);
  await page.selectOption("#invite-role", role);
  await page.getByTestId("invite-submit").click();
  // Wait for THIS invitation's result (an earlier one may still be on screen).
  await expect(page.getByTestId("invite-result")).toContainText(email);
  return page.getByTestId("invitation-link").inputValue();
}

for (const { locale, dir, notSent } of [
  { locale: "ar", dir: "rtl", notSent: "لم يُرسل أي بريد: لم يُعدّ مزوّد بريد إلكتروني." },
  { locale: "en", dir: "ltr", notSent: "No email was sent: no email provider is configured." },
] as const) {
  test(`invite, accept, change role and remove in /${locale} (${dir})`, async ({ browser }) => {
    const { page: owner, slug } = await ownerWithWorkspace(browser, locale);

    // Members page from the shell navigation.
    await owner.getByTestId("nav-members").click();
    await expect(owner).toHaveURL(`/${locale}/w/${slug}/members`);
    await expect(owner.locator("html")).toHaveAttribute("dir", dir);
    await expect(owner.getByTestId("nav-members")).toHaveAttribute("aria-current", "page");
    await expect(owner.getByTestId("member-row")).toHaveCount(1);
    await expect(owner.getByTestId("leave-last-owner")).toBeVisible();

    // Invite: the link is shown once and the page is honest about email delivery.
    const email = `e2e-invitee-${tag()}@example.com`;
    const link = await invite(owner, email, "EDITOR");
    expect(link).toMatch(new RegExp(`/${locale}/invite/[A-Za-z0-9_-]{43}$`));
    await expect(owner.getByTestId("invite-delivery")).toHaveText(notSent);
    await expect(owner.getByTestId("pending-row")).toHaveCount(1);
    const path = new URL(link).pathname;

    // The invitee opens the link signed out, creates an account and comes back.
    const invitee = await browser.newPage();
    await invitee.goto(path);
    await expect(invitee).toHaveURL(`/${locale}/sign-in?next=${encodeURIComponent(path)}`);
    await invitee.locator('a[href*="/sign-up?next="]').click();
    await invitee.fill("#sign-up-name", "Invitee");
    await invitee.fill("#sign-up-email", email);
    await invitee.fill("#sign-up-password", PASSWORD);
    await invitee.getByTestId("sign-up-submit").click();
    await expect(invitee).toHaveURL(new RegExp(`/${locale}/sign-in\\?registered=1&next=`));
    await invitee.fill("#sign-in-email", email);
    await invitee.fill("#sign-in-password", PASSWORD);
    await invitee.getByTestId("sign-in-submit").click();
    await expect(invitee).toHaveURL(path);
    await expect(invitee.locator("html")).toHaveAttribute("dir", dir);
    await expect(invitee.getByTestId("invitation-valid")).toBeVisible();
    await invitee.getByTestId("accept-invitation").click();
    await expect(invitee).toHaveURL(`/${locale}/w/${slug}`);
    await expect(invitee.getByTestId("nav-members")).toBeVisible();

    // The link is spent.
    await invitee.goto(path);
    await expect(invitee.getByTestId("invitation-invalid")).toBeVisible();

    // The owner sees the new member, changes the role, then removes them.
    await owner.reload();
    await expect(owner.getByTestId("member-row")).toHaveCount(2);
    await expect(owner.getByTestId("pending-empty")).toBeVisible();
    const row = owner.locator(`[data-testid="member-row"][data-email="${email}"]`);
    await row.getByTestId("role-select").selectOption("VIEWER");
    await row.getByTestId("role-submit").click();
    await expect(row.getByTestId("role-select")).toHaveValue("VIEWER");
    await row.getByTestId("remove-member").locator("summary").click();
    await row.getByTestId("remove-member-confirm").click();
    await expect(owner.getByTestId("member-row")).toHaveCount(1);

    // The removed member is locked out at once.
    const response = await invitee.goto(`/${locale}/w/${slug}`);
    expect(response?.status()).toBe(404);
    await invitee.close();
    await owner.close();
  });
}

test("revoked links, wrong accounts and leaving", async ({ browser }) => {
  const { page: owner, slug } = await ownerWithWorkspace(browser, "en");
  await owner.goto(`/en/w/${slug}/members`);

  // Revoke: the link stops working.
  const revokedEmail = `e2e-revoked-${tag()}@example.com`;
  const revokedLink = new URL(await invite(owner, revokedEmail, "VIEWER")).pathname;
  const pending = owner.locator(`[data-testid="pending-row"][data-email="${revokedEmail}"]`);
  await pending.getByTestId("revoke-invitation").locator("summary").click();
  await pending.getByTestId("revoke-invitation-confirm").click();
  await expect(owner.getByTestId("pending-empty")).toBeVisible();

  const revokedUser = await browser.newPage();
  await signUpAndSignIn(revokedUser, "en", revokedEmail, "Revoked");
  await revokedUser.goto(revokedLink);
  await expect(revokedUser.getByTestId("invitation-invalid")).toBeVisible();
  await revokedUser.close();

  // A different account sees neither the workspace nor an accept button.
  const link = new URL(await invite(owner, `e2e-intended-${tag()}@example.com`, "ADMIN")).pathname;
  const stranger = await browser.newPage();
  await signUpAndSignIn(stranger, "en", `e2e-stranger-${tag()}@example.com`, "Stranger");
  await stranger.goto(link);
  await expect(stranger.getByTestId("invitation-email-mismatch")).toBeVisible();
  await expect(stranger.getByTestId("accept-invitation")).toHaveCount(0);
  await expect(stranger.getByText(`Team ${slug}`)).toHaveCount(0);
  await stranger.close();

  // A member can leave; afterwards the workspace is gone for them.
  const memberEmail = `e2e-leaver-${tag()}@example.com`;
  const memberLink = new URL(await invite(owner, memberEmail, "EDITOR")).pathname;
  const member = await browser.newPage();
  await signUpAndSignIn(member, "en", memberEmail, "Leaver");
  await member.goto(memberLink);
  await member.getByTestId("accept-invitation").click();
  await expect(member).toHaveURL(`/en/w/${slug}`);
  await member.goto(`/en/w/${slug}/members`);
  await member.getByTestId("leave-workspace").locator("summary").click();
  await member.getByTestId("leave-workspace-confirm").click();
  await expect(member).toHaveURL(/\/en\/workspaces/);
  expect((await member.goto(`/en/w/${slug}`))?.status()).toBe(404);
  await member.close();
  await owner.close();
});

test("members page fits a phone screen", async ({ browser }) => {
  const { page: owner, slug } = await ownerWithWorkspace(browser, "ar");
  await owner.setViewportSize({ width: 360, height: 740 });
  await owner.goto(`/ar/w/${slug}/members`);
  await invite(owner, `e2e-phone-${tag()}@example.com`, "MANAGER");
  const overflow = await owner.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await owner.close();
});
