export function logEvent(eventName: string, data: Record<string, any>): void {
  console.log(`[${eventName}]`, data);
} 