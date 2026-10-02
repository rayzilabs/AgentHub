export const CONSULTANT_COLORS = ['#1F4E79', '#2E7D6B', '#8E4C9E', '#B5651D', '#3D6FB6', '#A23B5A'] as const;

export function consultantColor(index: number): string {
  return CONSULTANT_COLORS[((index % CONSULTANT_COLORS.length) + CONSULTANT_COLORS.length) % CONSULTANT_COLORS.length];
}
