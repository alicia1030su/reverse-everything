package com.example.fixture;

/** Known-answer source mirrored by the deterministic synthetic DEX builder. */
public final class Fixture {
    private Fixture() {
    }

    public static String fixtureMarker() {
        return "hello-from-fixture";
    }
}
