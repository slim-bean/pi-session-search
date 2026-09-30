/** Tool parameter schemas shared by several tools. */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const maxChars = Type.Optional(Type.Integer({ minimum: 2000, maximum: 40_000, description: "Output character budget (default 16000 search, 20000 read). Pagination/continuation hints preserve access to omitted content." }));
export const match = Type.Optional(StringEnum(["all", "any"] as const, { description: "Require all terms (default) or any term within one entry." }));
