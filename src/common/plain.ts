/**
 * The plain-object shape of a response DTO class (deeply): services build
 * responses as object literals of this type, while the class itself only
 * documents the schema for Swagger (`@ApiOkResponse({ type: Dto })`).
 */
export type Plain<T> = T extends readonly (infer Item)[]
  ? Plain<Item>[]
  : T extends Date
    ? T
    : T extends object
      ? { [Key in keyof T]: Plain<T[Key]> }
      : T;
