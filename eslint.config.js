import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    // 어댑터는 ctx.http로만 요청한다. 전역 fetch를 쓰면 UA, 간격, 차단 감지 규칙을 건너뛴다.
    files: ["src/adapters/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "어댑터에서는 전역 fetch 대신 ctx.http를 쓴다." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: "어댑터에서는 전역 fetch 대신 ctx.http를 쓴다." },
      ],
    },
  },
);
