#!/bin/sh

# ##########################################################################
#  Gradle start up script for POSIX platform (GitHub Actions/Linux)
# ##########################################################################

# Resolve links - \$0 may be a soft link
PRG="\$0"

while [ -h "\$PRG" ] ; do
  ls=`ls -ld "$PRG"`
  link=`expr "$ls" : '.*-> \(.*\)$'`
  if expr "\$link" : '/.*' > /dev/null; then
    PRG="\$link"
  else
    PRG=`dirname "$PRG"`/"\$link"
  fi
done

PRGDIR=`dirname "$PRG"`
APP_FILENAME=`basename "$PRG"`
APP_HOME=`cd "$PRGDIR" >/dev/null; pwd`

# Add default JVM options here. You can also use JAVA_OPTS and GRADLE_OPTS to pass JVM flags to this script.
DEFAULT_JVM_OPTS='"-Xmx64m" "-Xms64m"'

warn () {
    echo "\$*"
}

die () {
    echo
    echo "\$*"
    echo
    exit 1
}

# Determine the Java command to use to start the JVM.
if [ -n "\$JAVA_HOME" ] ; then
    if [ -x "\$JAVA_HOME/bin/java" ] ; then
        JAVACMD="\$JAVA_HOME/bin/java"
    else
        die "ERROR: JAVA_HOME is set to an invalid directory: \$JAVA_HOME

Please set the JAVA_HOME variable in your environment to match the
location of your Java installation."
    fi
else
    JAVACMD="java"
    which java >/dev/null 2>&1 || die "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.

Please set the JAVA_HOME variable in your environment to match the
location of your Java installation."
fi

# Increase the maximum file descriptors if we can.
case "`uname`" in
  CYGWIN* | MINGW* | MSYS*)
    ;;
  *)
    MAX_FD_LIMIT=`ulimit -H -n`
    if [ \$? -eq 0 ] ; then
        if [ "\(MAX_FD" = "maximum" -o "\)MAX_FD" = "max" ] ; then
            MAX_FD="\$MAX_FD_LIMIT"
        fi
        ulimit -n \$MAX_FD
        if [ \$? -ne 0 ] ; then
            warn "Could not set maximum file descriptor limit: \$MAX_FD"
        fi
    fi
    ;;
esac

CLASSPATH=\$APP_HOME/gradle/wrapper/gradle-wrapper.jar

# Determine the arguments for passing to the java command
eval set -- "\(DEFAULT_JVM_OPTS" "\)GD_JVM_OPTS" "-classpath" '"CLASSPATH"' "org.gradle.wrapper.GradleWrapperMain" '"@"'

exec "JAVACMD" "@"
