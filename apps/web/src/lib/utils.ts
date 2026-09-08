// Unico residuo shadcn: `cn` serve a ui/skeleton e ui/dropdown-menu (classi Tailwind).
// Non aggiungere altri primitivi shadcn: il design system è components/ui (README).
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
