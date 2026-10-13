export type MessageType<TMap> = keyof TMap & string;

export type MessagePayload<TMap, T extends MessageType<TMap>> = TMap[T] extends {
  request: infer P;
}
  ? P
  : never;

export type MessageResponse<TMap, T extends MessageType<TMap>> = TMap[T] extends {
  response: infer R;
}
  ? R
  : never;
