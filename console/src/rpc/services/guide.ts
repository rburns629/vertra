// SPDX-License-Identifier: MIT
/**
 * GuideService (proto/vertra/console/v1/guide.proto): the guides in
 * console/docs/, for anyone signed in (the same content for everyone).
 */
import type { ServiceImpl } from "@connectrpc/connect";
import type { GuideService } from "../../gen/vertra/console/v1/guide_pb.js";
import { GuideId, listGuides, readGuide } from "../../guides.js";
import { notFound } from "../errors.js";
import { check } from "../validate.js";

export function guideService(): ServiceImpl<typeof GuideService> {
  return {
    async listGuides() {
      return { guides: await listGuides() };
    },

    async getGuide(req) {
      const { id } = check({ id: GuideId }, req);
      const markdown = await readGuide(id);
      if (markdown === undefined) throw notFound("No such guide.");
      return { markdown };
    },
  };
}
