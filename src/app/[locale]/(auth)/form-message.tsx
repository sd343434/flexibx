import type { ReactNode } from "react";

/** A status (role="status") or error (role="alert") panel shared by the auth forms. */
export function FormMessage({
  tone,
  children,
  testId,
}: {
  readonly tone: "status" | "error";
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return tone === "error" ? (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-destructive p-3 text-sm text-destructive"
      data-testid={testId}
    >
      {children}
    </div>
  ) : (
    <div role="status" className="space-y-2 rounded-md border p-3 text-sm" data-testid={testId}>
      {children}
    </div>
  );
}
