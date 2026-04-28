import { describe, it, expect, beforeEach } from "vitest";
import { useAuth } from "../auth";

beforeEach(() => {
  localStorage.clear();
  useAuth.setState({ auth: null });
});

describe("auth store", () => {
  it("speichert auth in localStorage", () => {
    useAuth.getState().setAuth({ access: "a", refresh: "r", email: "u@x.de" });
    expect(JSON.parse(localStorage.getItem("mynotes.auth")!)).toMatchObject({
      access: "a",
      email: "u@x.de",
    });
  });

  it("löscht auth aus localStorage bei null", () => {
    useAuth.getState().setAuth({ access: "a", refresh: "r", email: "u@x.de" });
    useAuth.getState().setAuth(null);
    expect(localStorage.getItem("mynotes.auth")).toBeNull();
    expect(useAuth.getState().auth).toBeNull();
  });
});
