import type { SVGProps } from "react";

export type IconName =
  | "arrow-down"
  | "check"
  | "chevron"
  | "download"
  | "keyboard"
  | "refresh"
  | "sliders"
  | "upload";

interface IconProps extends SVGProps<SVGSVGElement> {
  readonly name: IconName;
  readonly size?: number;
}

const paths: Record<IconName, React.ReactNode> = {
  "arrow-down": <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.2 4L19 7" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7 14h.01M10.5 14h7" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M18.1 16a8 8 0 10.3-8.3L20 9" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 20h14" />
    </>
  )
};

export function Icon({
  name,
  size = 18,
  ...props
}: IconProps): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
