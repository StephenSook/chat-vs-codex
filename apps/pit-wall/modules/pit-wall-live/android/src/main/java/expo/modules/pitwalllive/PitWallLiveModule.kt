package expo.modules.pitwalllive

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class PitWallLiveModule : Module() {
  private val expiryHandler = Handler(Looper.getMainLooper())
  private var expiry: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("PitWallLive")

    AsyncFunction("update") { json: String ->
      val context = requireNotNull(appContext.reactContext) { "React context is unavailable" }
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val state = JSONObject(json)
      expiry?.let { expiryHandler.removeCallbacks(it) }
      if (!state.getBoolean("active")) {
        manager.cancel(NOTIFICATION_ID)
      } else {
        if (Build.VERSION.SDK_INT >= 33 &&
          context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          throw IllegalStateException("Notification permission is required for round status")
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) {
          manager.createNotificationChannel(NotificationChannel(
            CHANNEL, "Pit Wall round", NotificationManager.IMPORTANCE_LOW))
          Notification.Builder(context, CHANNEL).setTimeoutAfter(60_000L)
        } else {
          @Suppress("DEPRECATION")
          Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
        }
        val title = "CHAT ${state.getInt("chatScore")} : ${state.getInt("codexScore")} CODEX"
        val detail = state.optString("headline").ifBlank {
          state.optString("step").ifBlank { state.getString("phase") }
        }
        builder.setSmallIcon(R.drawable.pit_wall_status)
          .setContentTitle(title)
          .setContentText("$detail · ${state.getInt("deaths")} deaths")
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setShowWhen(false)
          .setCategory(Notification.CATEGORY_PROGRESS)
          .setVisibility(Notification.VISIBILITY_PUBLIC)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
          builder.setContentIntent(PendingIntent.getActivity(context, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        if (!state.isNull("headStartEndsAt")) {
          val deadline = state.getDouble("headStartEndsAt").toLong()
          if (deadline > System.currentTimeMillis()) {
            builder.setWhen(deadline).setShowWhen(true)
              .setUsesChronometer(true).setChronometerCountDown(true)
          }
        }
        manager.notify(NOTIFICATION_ID, builder.build())
        expiry = Runnable { manager.cancel(NOTIFICATION_ID) }.also {
          expiryHandler.postDelayed(it, 60_000L)
        }
      }
    }
  }

  companion object {
    private const val CHANNEL = "pit-wall-round"
    private const val NOTIFICATION_ID = 4318
  }
}
