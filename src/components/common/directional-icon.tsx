import type { LucideIcon, LucideProps } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Renders a direction-sensitive icon (arrows, chevrons) mirrored in RTL so it always
 * points along the reading direction. Non-directional icons should not use this.
 */
export function DirectionalIcon({
  icon: Icon,
  className,
  ...props
}: LucideProps & { icon: LucideIcon }) {
  return <Icon aria-hidden="true" className={cn("rtl:-scale-x-100", className)} {...props} />;
}
