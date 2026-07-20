import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/lib/fieldMatcher.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const source = bundle.outputFiles[0].text;
const matcher = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function signals(overrides = {}) {
  return {
    label: "",
    placeholder: "",
    name: "",
    id: "",
    aria: "",
    nearby: "",
    autocomplete: "",
    ...overrides,
  };
}

const address1 = signals({ label: "Address Line 1", name: "addressLine1" });
assert.deepEqual(matcher.matchField(address1), {
  key: "address",
  confidence: "high",
  sensitive: false,
});
assert.equal(matcher.isSecondaryAddressField(address1), false);
assert.equal(matcher.isProfileMappingCompatible(address1, "address"), true);

for (const field of [
  signals({ label: "Address Line 2" }),
  signals({ name: "address_line_2" }),
  signals({ id: "addressLine3" }),
  signals({ placeholder: "Street address line 4" }),
  signals({ autocomplete: "address-line2" }),
]) {
  assert.equal(matcher.isSecondaryAddressField(field), true);
  assert.equal(matcher.matchField(field), null);
  assert.equal(matcher.isProfileMappingCompatible(field, "address"), false);
}

assert.equal(
  matcher.matchField(signals({ label: "Alternate email", autocomplete: "email" }))?.key,
  "alternateEmail",
);
assert.equal(
  matcher.matchField(signals({ label: "WhatsApp number", autocomplete: "tel" }))?.key,
  "whatsapp",
);
assert.equal(
  matcher.matchField(signals({ label: "Country of residence" }))?.key,
  "currentResidenceCountry",
);
assert.equal(
  matcher.matchField(signals({ label: "Secondary skills" }))?.key,
  "secondarySkills",
);

console.log("Field matcher regression tests passed.");
