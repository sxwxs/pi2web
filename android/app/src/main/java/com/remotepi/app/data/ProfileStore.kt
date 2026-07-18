package com.remotepi.app.data

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

class ProfileStore(context: Context) {
    private val prefs = context.getSharedPreferences("profiles", Context.MODE_PRIVATE)
    private val gson = Gson()
    fun list(): List<ServerProfile> = runCatching {
        gson.fromJson<List<ServerProfile>>(prefs.getString("servers", "[]"), object : TypeToken<List<ServerProfile>>() {}.type)
    }.getOrDefault(emptyList())
    fun save(profile: ServerProfile) {
        val profiles = list().filterNot { it.id == profile.id } + profile
        prefs.edit().putString("servers", gson.toJson(profiles)).putString("selected", profile.id).apply()
    }
    fun delete(id: String) { prefs.edit().putString("servers", gson.toJson(list().filterNot { it.id == id })).apply() }
    fun selectedId(): String? = prefs.getString("selected", null)
    fun select(id: String) { prefs.edit().putString("selected", id).apply() }
    fun cursor(agentId: String): Long = prefs.getLong("cursor_$agentId", 0)
    fun setCursor(agentId: String, sequence: Long) { prefs.edit().putLong("cursor_$agentId", sequence).apply() }
}
