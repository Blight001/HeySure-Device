# socket.io / engine.io rely on reflection-free callbacks, but keep them safe.
-keep class io.socket.** { *; }
-keep class ai.heysure.agent.** { *; }
