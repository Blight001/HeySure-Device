# socket.io / engine.io rely on reflection-free callbacks, but keep them safe.
-keep class io.socket.** { *; }
-keep class ai.heysure.agent.** { *; }

# Socket.IO's transport sits on OkHttp; keep it intact so WebSocket/polling still
# work after R8 shrinking, and silence warnings about its optional/compile-only deps.
-keep class okhttp3.** { *; }
-keep class okio.** { *; }
-dontwarn io.socket.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.json.**

-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
