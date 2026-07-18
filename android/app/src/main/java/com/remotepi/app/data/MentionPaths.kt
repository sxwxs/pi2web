package com.remotepi.app.data

object MentionPaths {
    fun initialPath(rootPath: String, cwd: String): String {
        val root=rootPath.trimEnd('/');val current=cwd.trimEnd('/')
        return if(current==root) "." else current.removePrefix("$root/").ifBlank { "." }
    }
    fun child(base: String, name: String): String = if(base==".")name else "$base/$name"
    fun parent(path: String): String = if(path==".") "." else path.substringBeforeLast('/', ".")
    fun reference(rootPath: String, cwd: String, relative: String): String {
        val absolute="${rootPath.trimEnd('/')}/${if(relative==".")"" else relative}".trimEnd('/');val current=cwd.trimEnd('/')
        val value=if(absolute==current)"." else if(absolute.startsWith("$current/"))absolute.removePrefix("$current/") else absolute
        return "@"+(if(value.contains(' '))"\"$value\"" else value)
    }
}
