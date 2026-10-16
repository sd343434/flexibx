/**
 * A left-to-right value inside text of either direction: identifiers, codes and numbers
 * joined by `_`, `-` or `/`. Without the isolate the Unicode bidi algorithm reorders their
 * parts in an Arabic (RTL) line, e.g. "777000_1029" would read "1029_777000".
 */
export function LtrText({ children }: { readonly children: string }) {
  return <bdi dir="ltr">{children}</bdi>;
}
