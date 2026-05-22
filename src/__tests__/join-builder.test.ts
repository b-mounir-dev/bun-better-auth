import { describe, expect, test } from "bun:test";
import { buildJoinParts, processJoinedRows } from "../join-builder";

describe("join builder", () => {
  test("buildJoinParts creates aliased select list", () => {
    const built = buildJoinParts({
      provider: "pg",
      baseAlias: "t",
      join: {
        session: {
          on: { from: "id", to: "userId" },
          relation: "one-to-many",
          limit: 2,
        },
      },
      getModelName: (model) => model,
      getFieldName: ({ field }) => field,
      getModelFields: () => ["id", "token"],
    });

    expect(built.joinSql).toContain("LEFT JOIN");
    expect(built.selectSql.length).toBe(2);
    expect(built.selectDescriptors[0]?.alias).toContain("_joined_session");
  });

  test("processJoinedRows groups one-to-many rows by main id", () => {
    const rows = [
      {
        id: "u_1",
        email: "a@example.com",
        _joined_session_id: "s_1",
        _joined_session_token: "one",
      },
      {
        id: "u_1",
        email: "a@example.com",
        _joined_session_id: "s_2",
        _joined_session_token: "two",
      },
    ];

    const processed = processJoinedRows({
      rows,
      join: {
        session: {
          on: { from: "id", to: "userId" },
          relation: "one-to-many",
          limit: 10,
        },
      },
      getModelName: (model) => model,
      getFieldName: ({ field }) => field,
      selectDescriptors: [
        {
          joinModel: "session",
          joinModelRef: "session",
          field: "id",
          alias: "_joined_session_id",
        },
        {
          joinModel: "session",
          joinModelRef: "session",
          field: "token",
          alias: "_joined_session_token",
        },
      ],
      mainIdField: "id",
    });

    expect(processed.length).toBe(1);
    expect(Array.isArray((processed[0] as any).session)).toBe(true);
    expect((processed[0] as any).session).toHaveLength(2);
  });

  test("processJoinedRows enforces one-to-many limit and dedups by id", () => {
    const rows = [
      {
        id: "u_1",
        _joined_session_id: "s_1",
        _joined_session_token: "one",
      },
      {
        id: "u_1",
        _joined_session_id: "s_1",
        _joined_session_token: "one-dup",
      },
      {
        id: "u_1",
        _joined_session_id: "s_2",
        _joined_session_token: "two",
      },
    ];

    const processed = processJoinedRows({
      rows,
      join: {
        session: {
          on: { from: "id", to: "userId" },
          relation: "one-to-many",
          limit: 1,
        },
      },
      getModelName: (model) => model,
      getFieldName: ({ field }) => field,
      selectDescriptors: [
        {
          joinModel: "session",
          joinModelRef: "session",
          field: "id",
          alias: "_joined_session_id",
        },
        {
          joinModel: "session",
          joinModelRef: "session",
          field: "token",
          alias: "_joined_session_token",
        },
      ],
      mainIdField: "id",
    });

    expect((processed[0] as any).session).toHaveLength(1);
    expect((processed[0] as any).session[0].id).toBe("s_1");
  });

  test("processJoinedRows maps one-to-one relation to object or null", () => {
    const rows = [
      {
        id: "u_1",
        _joined_profile_id: "p_1",
        _joined_profile_bio: "hello",
      },
      {
        id: "u_2",
        _joined_profile_id: null,
        _joined_profile_bio: null,
      },
    ];

    const processed = processJoinedRows({
      rows,
      join: {
        profile: {
          on: { from: "id", to: "userId" },
          relation: "one-to-one",
        },
      },
      getModelName: (model) => model,
      getFieldName: ({ field }) => field,
      selectDescriptors: [
        {
          joinModel: "profile",
          joinModelRef: "profile",
          field: "id",
          alias: "_joined_profile_id",
        },
        {
          joinModel: "profile",
          joinModelRef: "profile",
          field: "bio",
          alias: "_joined_profile_bio",
        },
      ],
      mainIdField: "id",
    });

    expect((processed[0] as any).profile).toEqual({ id: "p_1", bio: "hello" });
    expect((processed[1] as any).profile).toBeNull();
  });
});
