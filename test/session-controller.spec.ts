import { callbackPage } from "../src/auth/session.controller";

describe("native login callback page", () => {
  test("keeps attacker-controlled markup out of the executable script", () => {
    const attack =
      "loc://auth/complete?error=</script><script>alert(1)</script>\u2028next";
    const page = callbackPage(attack, false, "test-nonce");

    expect(page).not.toContain("</script><script>");
    expect(page).toContain(
      "\\u003c/script>\\u003cscript>alert(1)\\u003c/script>",
    );
    expect(page).toContain("\\u2028next");
    expect(page).toContain('nonce="test-nonce"');
    expect(page).toContain("loc://auth/complete");
  });
});
