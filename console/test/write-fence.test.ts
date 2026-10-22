// SPDX-License-Identifier: MIT
/**
 * The console's write fence must be in force before it starts (k8s.ts's
 * fenceProblem): a policy that fails closed and checks something, bound to
 * deny. Proven against the cluster on kind (docs/operations.md); this is
 * the check on what the API server returns.
 */
import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { fenceProblem } from "../src/k8s.js";

const name = "console-execution-console-write-fence";
const policy = (spec: Partial<k8s.V1ValidatingAdmissionPolicySpec>) =>
  ({ spec: { failurePolicy: "Fail", validations: [{ expression: "true" }], ...spec } }) as k8s.V1ValidatingAdmissionPolicy;
const binding = (spec: Partial<k8s.V1ValidatingAdmissionPolicyBindingSpec>) =>
  ({ spec: { policyName: name, validationActions: ["Deny"], ...spec } }) as k8s.V1ValidatingAdmissionPolicyBinding;

describe("the write fence", () => {
  it("is in force as the chart makes it", () => {
    expect(fenceProblem(name, policy({}), binding({}))).toBeNull();
  });

  it("isn't when it fails open, checks nothing, binds another policy or only warns", () => {
    expect(fenceProblem(name, policy({ failurePolicy: "Ignore" }), binding({}))).toMatch(/fail closed/);
    expect(fenceProblem(name, policy({ validations: [] }), binding({}))).toMatch(/checks nothing/);
    expect(fenceProblem(name, policy({}), binding({ policyName: "another" }))).toMatch(/another policy/);
    expect(fenceProblem(name, policy({}), binding({ validationActions: ["Warn"] }))).toMatch(/doesn't deny/);
  });
});
