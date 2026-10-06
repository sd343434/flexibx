"use client";

// Last-resort boundary for errors in the root layout itself. It replaces the whole
// document, so it cannot rely on i18n providers — the copy is bilingual and static.
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          margin: 0,
        }}
      >
        <main style={{ textAlign: "center" }}>
          <h1>حدث خطأ غير متوقع</h1>
          <p lang="en" dir="ltr">
            Something went wrong
          </p>
          <button type="button" onClick={reset}>
            إعادة المحاولة · Try again
          </button>
        </main>
      </body>
    </html>
  );
}
