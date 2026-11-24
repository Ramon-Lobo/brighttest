function Config_apiBase() as string
    return "https://api.example.com/v1"
end function

function Config_resumeKey(id as string) as string
    return "resume_" + id
end function
