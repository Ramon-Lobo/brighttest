function Resume_clamp(position as float, duration as float) as float
    if position < 0 then return 0
    if position > duration then return duration
    return position
end function
