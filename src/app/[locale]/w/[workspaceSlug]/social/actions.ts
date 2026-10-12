"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import type { ActionResult } from "@/server/http/action-handler";
import {
  addRuleAction,
  applyGuidanceAction,
  approveReplyAction,
  assignChannelAction,
  cancelPostAction,
  dismissLessonAction,
  ignoreInteractionAction,
  pullRecentAction,
  queuePostAction,
  redraftAction,
  rejectReplyAction,
  resolvePostAction,
  resolveUncertainAction,
  retryReplyAction,
  saveAgentAction,
  selfReviewAction,
  setAgentActiveAction,
  subscribeChannelAction,
  syncChannelsAction,
} from "@/server/social/social-actions";

import type { MarketingFormState } from "../marketing-actions";

// Form entry points for the AI Social Manager. Each forwards only the fields it names;
// what may be read, replied, sent or configured is decided on the server.

const base = (locale: string, slug: string) =>
  `/${isLocale(locale) ? locale : DEFAULT_LOCALE}/w/${encodeURIComponent(slug)}/social`;
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
function finish(
  result: ActionResult<unknown>,
  locale: string,
  slug: string,
  values: Record<string, string> = {},
): MarketingFormState {
  if (!result.ok) return { error: result.error, values };
  revalidatePath(base(locale, slug), "layout");
  return { done: true, at: Date.now() };
}

/** FAQ lines: "question :: answer". */
function faqOf(raw: string) {
  return raw
    .split("\n")
    .map((line) => line.split("::"))
    .filter((parts) => parts.length >= 2)
    .map(([q, ...a]) => ({ q: (q ?? "").trim(), a: a.join("::").trim() }))
    .filter((item) => item.q !== "" && item.a !== "");
}

export async function submitAgent(
  slug: string,
  locale: string,
  agentId: string | null,
  _previous: MarketingFormState,
  formData: FormData,
): Promise<MarketingFormState> {
  const values = {
    name: text(formData, "name"),
    role: text(formData, "role") || "customer_service",
    language: text(formData, "language") || "auto",
    tone: text(formData, "tone"),
    businessInfo: text(formData, "businessInfo"),
    faq: text(formData, "faq"),
    policies: text(formData, "policies"),
    escalation: text(formData, "escalation"),
    forbidden: text(formData, "forbidden"),
    mode: text(formData, "mode") || "SUGGEST",
    minConfidence: text(formData, "minConfidence") || "85",
    dailyAutoCap: text(formData, "dailyAutoCap") || "50",
  };
  const autoCategories = formData
    .getAll("autoCategories")
    .filter((v): v is string => typeof v === "string");
  const result = await saveAgentAction({
    slug,
    agentId,
    ...values,
    faq: faqOf(values.faq),
    autoCategories,
  });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(base(locale, slug), "layout");
  if (agentId === null) redirect(`${base(locale, slug)}/agents/${result.data.id}`);
  return { done: true, at: Date.now() };
}

export async function submitAgentActive(
  slug: string,
  locale: string,
  agentId: string,
  active: boolean,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await setAgentActiveAction({ slug, agentId, active }), locale, slug);
}

export async function submitSyncChannels(
  slug: string,
  locale: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await syncChannelsAction({ slug }), locale, slug);
}

export async function submitAssignChannel(
  slug: string,
  locale: string,
  channelId: string,
  _p: MarketingFormState,
  formData: FormData,
) {
  const agent = text(formData, "agentId");
  return finish(
    await assignChannelAction({
      slug,
      channelId,
      agentId: agent === "" ? null : agent,
      enabled: formData.get("enabled") === "on",
    }),
    locale,
    slug,
  );
}

export async function submitSubscribe(
  slug: string,
  locale: string,
  channelId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await subscribeChannelAction({ slug, channelId }), locale, slug);
}

export async function submitPull(
  slug: string,
  locale: string,
  channelId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await pullRecentAction({ slug, channelId }), locale, slug);
}

export async function submitApprove(
  slug: string,
  locale: string,
  replyId: string,
  _p: MarketingFormState,
  formData: FormData,
) {
  const edited = text(formData, "text");
  return finish(
    await approveReplyAction({ slug, replyId, text: edited === "" ? null : edited }),
    locale,
    slug,
    { text: edited },
  );
}

export async function submitReject(
  slug: string,
  locale: string,
  replyId: string,
  _p: MarketingFormState,
  formData: FormData,
) {
  return finish(
    await rejectReplyAction({ slug, replyId, reason: text(formData, "reason") }),
    locale,
    slug,
  );
}

export async function submitIgnore(
  slug: string,
  locale: string,
  interactionId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await ignoreInteractionAction({ slug, interactionId }), locale, slug);
}

export async function submitRedraft(
  slug: string,
  locale: string,
  interactionId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await redraftAction({ slug, interactionId }), locale, slug);
}

export async function submitResolve(
  slug: string,
  locale: string,
  replyId: string,
  statement: "check" | "sent" | "not_sent",
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await resolveUncertainAction({ slug, replyId, statement }), locale, slug);
}

export async function submitRetry(
  slug: string,
  locale: string,
  replyId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await retryReplyAction({ slug, replyId }), locale, slug);
}

export async function submitSelfReview(
  slug: string,
  locale: string,
  agentId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await selfReviewAction({ slug, agentId }), locale, slug);
}

export async function submitApplyGuidance(
  slug: string,
  locale: string,
  lessonId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await applyGuidanceAction({ slug, lessonId }), locale, slug);
}

export async function submitDismissLesson(
  slug: string,
  locale: string,
  lessonId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  return finish(await dismissLessonAction({ slug, lessonId }), locale, slug);
}

export async function submitRule(
  slug: string,
  locale: string,
  agentId: string,
  _p: MarketingFormState,
  formData: FormData,
) {
  return finish(await addRuleAction({ slug, agentId, rule: text(formData, "rule") }), locale, slug);
}

export async function submitQueuePost(
  slug: string,
  locale: string,
  contentId: string,
  _p: MarketingFormState,
  formData: FormData,
) {
  const result = await queuePostAction({ slug, contentId, channelId: text(formData, "channelId") });
  if (!result.ok) return { error: result.error, values: {} };
  revalidatePath(
    `${base(locale, slug).replace(/\/social$/, "")}/content/${encodeURIComponent(contentId)}`,
  );
  return { done: true, at: Date.now() } as const;
}

export async function submitCancelPost(
  slug: string,
  locale: string,
  contentId: string,
  postId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  const result = await cancelPostAction({ slug, postId });
  if (!result.ok) return { error: result.error, values: {} };
  revalidatePath(
    `${base(locale, slug).replace(/\/social$/, "")}/content/${encodeURIComponent(contentId)}`,
  );
  return { done: true, at: Date.now() } as const;
}

export async function submitResolvePost(
  slug: string,
  locale: string,
  contentId: string,
  postId: string,
  _p: MarketingFormState,
  _f: FormData,
) {
  const result = await resolvePostAction({ slug, postId });
  if (!result.ok) return { error: result.error, values: {} };
  revalidatePath(
    `${base(locale, slug).replace(/\/social$/, "")}/content/${encodeURIComponent(contentId)}`,
  );
  return { done: true, at: Date.now() } as const;
}
