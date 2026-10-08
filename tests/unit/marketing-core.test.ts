import { describe, expect, it } from "vitest";

import { parseStorageDriver } from "@/server/env-schema";
import { fromMinorUnits, toMinorUnits } from "@/server/marketing/campaign-service";
import { MAX_IMAGE_DIMENSION, sanitizeFilename, sniffImage } from "@/server/marketing/image";
import {
  brandFieldsSchema,
  calendarQuerySchema,
  contentListQuerySchema,
  createAudienceInputSchema,
  createCampaignInputSchema,
  createContentInputSchema,
  createGoalInputSchema,
  saveBrandInputSchema,
  textList,
  transitionContentInputSchema,
  updatePillarInputSchema,
} from "@/server/marketing/inputs";
import {
  addDays,
  calendarPeriod,
  dayOfWeek,
  isDateKey,
  resolveTimeZone,
  utcToZonedLocal,
  zonedDateKey,
  zonedLocalToUtc,
} from "@/server/marketing/time";
import {
  CAMPAIGN_STATUS_TRANSITIONS,
  CONTENT_TRANSITION_RULES,
  canChangeCampaignStatus,
  contentDeletePermission,
  isCampaignEditable,
  isContentEditable,
  isTransitionAllowedFrom,
  reschedulePermission,
  transitionsFrom,
} from "@/server/marketing/workflow";
import { zodIssuesToFieldErrors } from "@/server/validation/field-errors";
import { parseInput } from "@/server/validation/parse";
import { AppError } from "@/server/errors/app-error";

const SLUG = "acme-team";
const ID = "0b9a3c39-8c56-4c2e-9d4c-3b2f6a0c1d11";

const brand = {
  slug: SLUG,
  name: "Qahwa",
  description: "",
  website: "",
  industry: "",
  market: "",
  language: "AR",
  mission: "",
  positioning: "",
  valueProposition: "",
  toneOfVoice: "",
  personality: "",
  keywords: "",
  forbiddenWords: "",
  ctaStyle: "",
};

function fieldCodes(schema: Parameters<typeof parseInput>[0], input: unknown) {
  try {
    parseInput(schema, input);
  } catch (error) {
    if (error instanceof AppError)
      return error.fields.map((field) => `${field.path}:${field.code}`);
    throw error;
  }
  return [];
}

describe("marketing input schemas", () => {
  it("are strict: a workspace id, status or creator cannot be smuggled in", () => {
    expect(saveBrandInputSchema.safeParse({ ...brand, workspaceId: ID }).success).toBe(false);
    const content = { slug: SLUG, title: "Hello", type: "POST" };
    expect(createContentInputSchema.safeParse(content).success).toBe(true);
    for (const extra of [{ status: "PUBLISHED" }, { createdByUserId: ID }, { workspaceId: ID }]) {
      expect(createContentInputSchema.safeParse({ ...content, ...extra }).success).toBe(false);
    }
    expect(fieldCodes(createContentInputSchema, { ...content, status: "PUBLISHED" })).toContain(
      ":unrecognized_keys",
    );
  });

  it("trims text, turns empty optional text into null and enforces lengths", () => {
    const { slug: _slug, ...fields } = brand;
    const parsed = brandFieldsSchema.parse({ ...fields, name: "  Qahwa  " });
    expect(parsed.name).toBe("Qahwa");
    expect(parsed.description).toBeNull();
    expect(parsed.website).toBeNull();
    expect(brandFieldsSchema.safeParse({ ...fields, name: "   " }).success).toBe(false);
    expect(brandFieldsSchema.safeParse({ ...fields, name: "x".repeat(121) }).success).toBe(false);
  });

  it("splits lists on new lines, commas and Arabic commas, dropping blanks and duplicates", () => {
    const schema = textList(5, 10);
    expect(schema.parse("قهوة، مختصة\nRiyadh,  coffee ,coffee,,")).toEqual([
      "قهوة",
      "مختصة",
      "Riyadh",
      "coffee",
    ]);
    expect(schema.parse(undefined)).toEqual([]);
    expect(schema.parse([" a ", "a", "b"])).toEqual(["a", "b"]);
    expect(schema.safeParse("1,2,3,4,5,6").success).toBe(false);
    expect(schema.safeParse("x".repeat(11)).success).toBe(false);
  });

  it("accepts only absolute http(s) URLs", () => {
    const parse = (website: string) =>
      saveBrandInputSchema.safeParse({ ...brand, website }).success;
    expect(parse("https://qahwa.example/path")).toBe(true);
    expect(parse("http://qahwa.example")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example", "qahwa"]) {
      expect(parse(bad)).toBe(false);
    }
  });

  it("parses audience attributes as labelled lines and rejects unlabelled ones", () => {
    const base = { slug: SLUG, name: "Pros" };
    const parsed = createAudienceInputSchema.parse({
      ...base,
      attributes: "Age: 25–34\n\nالمدينة： الرياض",
    });
    expect(parsed.attributes).toEqual([
      { label: "Age", value: "25–34" },
      { label: "المدينة", value: "الرياض" },
    ]);
    expect(createAudienceInputSchema.safeParse({ ...base, attributes: "no label" }).success).toBe(
      false,
    );
    const many = Array.from({ length: 21 }, (_, index) => `k${String(index)}: v`).join("\n");
    expect(createAudienceInputSchema.safeParse({ ...base, attributes: many }).success).toBe(false);
  });

  it("checks goal dates and targets, reporting the date_range code", () => {
    const goal = { slug: SLUG, type: "SALES", title: "Grow", status: "ACTIVE" };
    expect(createGoalInputSchema.parse({ ...goal, target: " 1500.5 " }).target).toBe("1500.5");
    expect(createGoalInputSchema.safeParse({ ...goal, target: "-1" }).success).toBe(false);
    expect(createGoalInputSchema.safeParse({ ...goal, target: "1.234" }).success).toBe(false);
    expect(createGoalInputSchema.safeParse({ ...goal, startDate: "2030-02-30" }).success).toBe(
      false,
    );
    expect(
      fieldCodes(createGoalInputSchema, {
        ...goal,
        startDate: "2030-03-01",
        endDate: "2030-02-01",
      }),
    ).toEqual(["endDate:date_range"]);
    const same = createGoalInputSchema.parse({
      ...goal,
      startDate: "2030-03-01",
      endDate: "2030-03-01",
    });
    expect(same.startDate?.toISOString()).toBe("2030-03-01T00:00:00.000Z");
  });

  it("requires budget amount and currency together and normalizes the currency", () => {
    const campaign = { slug: SLUG, name: "Launch" };
    expect(
      createCampaignInputSchema.parse({ ...campaign, budgetAmount: "10", budgetCurrency: " sar " })
        .budgetCurrency,
    ).toBe("SAR");
    expect(fieldCodes(createCampaignInputSchema, { ...campaign, budgetAmount: "10" })).toEqual([
      "budgetCurrency:budget_pair",
    ]);
    expect(
      createCampaignInputSchema.safeParse({
        ...campaign,
        budgetAmount: "1",
        budgetCurrency: "RIYAL",
      }).success,
    ).toBe(false);
    const ids = createCampaignInputSchema.parse({ ...campaign, goalIds: [ID, ID], pillarIds: ID });
    expect(ids.goalIds).toEqual([ID]);
    expect(ids.pillarIds).toEqual([ID]);
    expect(createCampaignInputSchema.safeParse({ ...campaign, goalIds: ["x"] }).success).toBe(
      false,
    );
  });

  it("validates content links, times and transitions", () => {
    const content = { slug: SLUG, title: "Hi", type: "POST" };
    const parsed = createContentInputSchema.parse({
      ...content,
      campaignId: "",
      plannedAt: "2030-01-15T10:30",
      hashtags: "#a #a, #b",
    });
    expect(parsed.campaignId).toBeNull();
    expect(parsed.plannedAt).toBe("2030-01-15T10:30");
    expect(parsed.hashtags).toEqual(["#a #a", "#b"]);
    expect(
      createContentInputSchema.safeParse({ ...content, plannedAt: "2030-01-15" }).success,
    ).toBe(false);
    expect(createContentInputSchema.safeParse({ ...content, type: "TWEET" }).success).toBe(false);
    expect(
      createContentInputSchema.safeParse({ ...content, body: "x".repeat(10001) }).success,
    ).toBe(false);
    const transition = { slug: SLUG, contentId: ID };
    expect(
      transitionContentInputSchema.safeParse({ ...transition, transition: "publish" }).success,
    ).toBe(true);
    // A target status is not a transition.
    expect(
      transitionContentInputSchema.safeParse({ ...transition, transition: "PUBLISHED" }).success,
    ).toBe(false);
  });

  it("reads checkbox values for archiving pillars", () => {
    const pillar = { slug: SLUG, pillarId: ID, name: "Edu" };
    expect(updatePillarInputSchema.parse({ ...pillar, archived: "on" }).archived).toBe(true);
    expect(updatePillarInputSchema.parse({ ...pillar, archived: "" }).archived).toBe(false);
    expect(updatePillarInputSchema.parse(pillar).archived).toBe(false);
  });

  it("falls back to safe defaults for list and calendar query strings", () => {
    expect(contentListQuerySchema.parse({ status: "BOGUS", page: "-3", campaignId: "x" })).toEqual({
      status: undefined,
      type: undefined,
      campaignId: undefined,
      pillarId: undefined,
      q: undefined,
      page: 1,
    });
    expect(calendarQuerySchema.parse({ view: "month", date: "nope" })).toEqual({
      view: "week",
      date: undefined,
    });
  });

  it("maps a refinement's own code to the field error", () => {
    const result = createGoalInputSchema.safeParse({
      slug: SLUG,
      type: "SALES",
      title: "x",
      status: "ACTIVE",
      startDate: "2030-02-02",
      endDate: "2030-02-01",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(zodIssuesToFieldErrors(result.error.issues)).toEqual([
        { path: "endDate", code: "date_range" },
      ]);
    }
  });
});

describe("content workflow rules", () => {
  it("defines exactly the documented transitions", () => {
    const table = Object.fromEntries(
      Object.entries(CONTENT_TRANSITION_RULES).map(([name, rule]) => [
        name,
        `${rule.from.join("|")}→${rule.to} (${rule.permission})`,
      ]),
    );
    expect(table).toEqual({
      submit: "DRAFT→IN_REVIEW (content.edit)",
      withdraw: "IN_REVIEW→DRAFT (content.edit)",
      approve: "IN_REVIEW→APPROVED (content.approve)",
      request_changes: "IN_REVIEW→DRAFT (content.approve)",
      reopen: "APPROVED→DRAFT (content.edit)",
      schedule: "APPROVED→SCHEDULED (content.publish)",
      unschedule: "SCHEDULED→APPROVED (content.publish)",
      publish: "APPROVED|SCHEDULED→PUBLISHED (content.publish)",
    });
  });

  it("lists transitions per status; PUBLISHED is final", () => {
    expect(transitionsFrom("DRAFT")).toEqual(["submit"]);
    expect(transitionsFrom("IN_REVIEW")).toEqual(["withdraw", "approve", "request_changes"]);
    expect(transitionsFrom("APPROVED")).toEqual(["reopen", "schedule", "publish"]);
    expect(transitionsFrom("SCHEDULED")).toEqual(["unschedule", "publish"]);
    expect(transitionsFrom("PUBLISHED")).toEqual([]);
    expect(isTransitionAllowedFrom("approve", "DRAFT")).toBe(false);
    expect(isTransitionAllowedFrom("publish", "DRAFT")).toBe(false);
  });

  it("allows editing drafts only and ties delete/reschedule to the status", () => {
    expect(isContentEditable("DRAFT")).toBe(true);
    for (const status of ["IN_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED"] as const) {
      expect(isContentEditable(status)).toBe(false);
      expect(contentDeletePermission(status)).toBe("content.publish");
    }
    expect(contentDeletePermission("DRAFT")).toBe("content.edit");
    expect(reschedulePermission("DRAFT")).toBe("content.edit");
    expect(reschedulePermission("APPROVED")).toBe("content.edit");
    expect(reschedulePermission("SCHEDULED")).toBe("content.publish");
    expect(reschedulePermission("PUBLISHED")).toBeNull();
  });

  it("moves campaigns forward only along the lifecycle; ARCHIVED is final", () => {
    expect(canChangeCampaignStatus("DRAFT", "ACTIVE")).toBe(true);
    expect(canChangeCampaignStatus("ACTIVE", "DRAFT")).toBe(false);
    expect(canChangeCampaignStatus("COMPLETED", "ACTIVE")).toBe(false);
    expect(canChangeCampaignStatus("ACTIVE", "ACTIVE")).toBe(false);
    expect(CAMPAIGN_STATUS_TRANSITIONS.ARCHIVED).toEqual([]);
    for (const [from, targets] of Object.entries(CAMPAIGN_STATUS_TRANSITIONS)) {
      if (from !== "ARCHIVED") expect(targets).toContain("ARCHIVED");
    }
    expect(isCampaignEditable("ARCHIVED")).toBe(false);
    expect(isCampaignEditable("COMPLETED")).toBe(true);
  });
});

describe("workspace time zones", () => {
  it("converts Riyadh wall-clock times (UTC+3) both ways", () => {
    const instant = zonedLocalToUtc("2030-01-15T10:30", "Asia/Riyadh");
    expect(instant?.toISOString()).toBe("2030-01-15T07:30:00.000Z");
    expect(utcToZonedLocal(new Date("2030-01-15T07:30:00Z"), "Asia/Riyadh")).toBe(
      "2030-01-15T10:30",
    );
    expect(zonedDateKey(new Date("2030-01-15T22:00:00Z"), "Asia/Riyadh")).toBe("2030-01-16");
  });

  it("handles daylight saving time in zones that have it", () => {
    // New York: EST (UTC−5) in January, EDT (UTC−4) in July.
    expect(zonedLocalToUtc("2030-01-15T09:00", "America/New_York")?.toISOString()).toBe(
      "2030-01-15T14:00:00.000Z",
    );
    expect(zonedLocalToUtc("2030-07-15T09:00", "America/New_York")?.toISOString()).toBe(
      "2030-07-15T13:00:00.000Z",
    );
    // 02:30 does not exist on 2030-03-10; it resolves after the jump.
    expect(zonedLocalToUtc("2030-03-10T02:30", "America/New_York")?.toISOString()).toBe(
      "2030-03-10T07:30:00.000Z",
    );
  });

  it("rejects impossible dates and times and unknown zones", () => {
    for (const bad of ["2030-02-30T10:00", "2030-13-01T10:00", "2030-01-01T24:00", "soon"]) {
      expect(zonedLocalToUtc(bad, "Asia/Riyadh")).toBeNull();
    }
    expect(isDateKey("2030-02-29")).toBe(false);
    expect(isDateKey("2028-02-29")).toBe(true);
    expect(resolveTimeZone("Mars/Olympus")).toBe("Asia/Riyadh");
    expect(resolveTimeZone(null)).toBe("Asia/Riyadh");
    expect(resolveTimeZone("Europe/London")).toBe("Europe/London");
  });

  it("builds Sunday-first weeks and single days with zone-correct bounds", () => {
    expect(dayOfWeek("2030-01-15")).toBe(2); // Tuesday
    const week = calendarPeriod("week", "2030-01-15", "Asia/Riyadh");
    expect(week.days).toEqual([
      "2030-01-13",
      "2030-01-14",
      "2030-01-15",
      "2030-01-16",
      "2030-01-17",
      "2030-01-18",
      "2030-01-19",
    ]);
    expect(week.start.toISOString()).toBe("2030-01-12T21:00:00.000Z");
    expect(week.end.toISOString()).toBe("2030-01-19T21:00:00.000Z");
    expect(week.previous).toBe("2030-01-06");
    expect(week.next).toBe("2030-01-20");
    const sunday = calendarPeriod("week", "2030-01-13", "Asia/Riyadh");
    expect(sunday.days[0]).toBe("2030-01-13");
    const day = calendarPeriod("day", "2030-01-15", "Asia/Riyadh");
    expect(day.days).toEqual(["2030-01-15"]);
    expect(day.previous).toBe("2030-01-14");
    expect(day.next).toBe("2030-01-16");
    expect(addDays("2030-12-31", 1)).toBe("2031-01-01");
  });
});

describe("image sniffing", () => {
  const png = (width: number, height: number) => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(bytes.buffer).setUint32(16, width);
    new DataView(bytes.buffer).setUint32(20, height);
    return bytes;
  };
  const jpeg = (width: number, height: number) =>
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00, // SOI, APP0 (length 4)
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      height >> 8,
      height & 255,
      width >> 8,
      width & 255,
      0x03,
    ]);
  const riff = (chunk: string, payload: number[]) => {
    const bytes = new Uint8Array(30 + 4);
    bytes.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk)]);
    bytes.set(payload, 20);
    return bytes;
  };

  it("reads PNG, JPEG and WebP (lossy, lossless, extended) sizes from the bytes", () => {
    expect(sniffImage(png(640, 480))).toEqual({
      contentType: "image/png",
      width: 640,
      height: 480,
    });
    expect(sniffImage(jpeg(1920, 1080))).toEqual({
      contentType: "image/jpeg",
      width: 1920,
      height: 1080,
    });
    // Chunk payload from offset 20. VP8: frame tag (3), start code 9D 01 2A, then 14-bit width/height.
    expect(sniffImage(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]))).toEqual({
      contentType: "image/webp",
      width: 640,
      height: 480,
    });
    // VP8L: signature 0x2F, 14-bit (width−1) and (height−1).
    expect(sniffImage(riff("VP8L", [0x2f, 0x7f, 0xc2, 0x77, 0x00]))).toEqual({
      contentType: "image/webp",
      width: 640,
      height: 480,
    });
    // VP8X: flags (4), then 24-bit (width−1) and (height−1) at offsets 24 and 27.
    expect(sniffImage(riff("VP8X", [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]))).toEqual({
      contentType: "image/webp",
      width: 640,
      height: 480,
    });
  });

  it("rejects SVG, HTML, truncated files and absurd dimensions", () => {
    const text = (value: string) => new Uint8Array(Buffer.from(value));
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(text("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(png(640, 480).subarray(0, 20))).toBeNull();
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(png(MAX_IMAGE_DIMENSION + 1, 10))).toBeNull();
    expect(sniffImage(png(MAX_IMAGE_DIMENSION, 10))).not.toBeNull();
    expect(sniffImage(jpeg(10, 10).subarray(0, 12))).toBeNull();
    // A JPEG whose scan starts before any frame header has no size.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
  });

  it("keeps display file names free of paths and control or bidi characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\photo.png")).toBe("photo.png");
    expect(sanitizeFilename("cup\u202egnp.exe")).toBe("cupgnp.exe");
    expect(sanitizeFilename("a\u0000b\nc.png")).toBe("abc.png");
    expect(sanitizeFilename("..")).toBe("image");
    expect(sanitizeFilename("صورة القهوة.webp")).toBe("صورة القهوة.webp");
    expect(sanitizeFilename(`${"x".repeat(300)}.png`)).toHaveLength(255);
  });
});

describe("budgets in minor units", () => {
  it("converts major-unit text to minor units and back without floating point", () => {
    expect(toMinorUnits("1500")).toBe(150000n);
    expect(toMinorUnits("1500.5")).toBe(150050n);
    expect(toMinorUnits("0.07")).toBe(7n);
    expect(toMinorUnits("999999999999.99")).toBe(99999999999999n);
    expect(fromMinorUnits(150050n)).toBe("1500.50");
    expect(fromMinorUnits(7n)).toBe("0.07");
    expect(fromMinorUnits(-150n)).toBe("-1.50");
  });
});

describe("storage driver selection", () => {
  it("defaults to S3 and accepts the explicitly test-only memory driver", () => {
    expect(parseStorageDriver({})).toBe("s3");
    expect(parseStorageDriver({ STORAGE_DRIVER: "" })).toBe("s3");
    expect(parseStorageDriver({ STORAGE_DRIVER: "test-memory" })).toBe("test-memory");
    expect(() => parseStorageDriver({ STORAGE_DRIVER: "memory" })).toThrow(/STORAGE_DRIVER/);
    expect(() => parseStorageDriver({ STORAGE_DRIVER: "disk" })).toThrow(/STORAGE_DRIVER/);
  });
});
